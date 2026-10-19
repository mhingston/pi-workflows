import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadWorkflow, sha256 } from "../src/artifact.ts";
import { createWorkflowInvocationService } from "../src/invocation.ts";
import { FilePublicationStore } from "../src/publication.ts";
import {
  ProviderRegistry, requireCapabilities, type Capability, type ProviderDescriptor,
} from "../src/providers.ts";
import { trustedFixture } from "./support/trusted-fixture.ts";
import type { RunInput, WorkflowOutcome } from "../src/durable/fixture-runtime.ts";

const capabilities = [
  "agent", "hooks", "approval", "dynamic_tasks", "native_child_tasks",
  "timers", "durable_replay", "provider_pi_durable_native_tasks",
] as const satisfies readonly Capability[];
const provider: ProviderDescriptor = {
  id: "pi_durable", version: "1.3.0",
  implementationSha256: "a".repeat(64), capabilities,
};
const binding = {
  runtime: provider,
  resolvedDependencies: { "@earendil-works/pi-durable": "1.3.0" },
};

async function fixture() {
  const [source, manifestJson] = await Promise.all([
    readFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/complex/workflow.json", import.meta.url), "utf8"),
  ]);
  return loadWorkflow({ source, manifestJson });
}
async function inTemp(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflows-publish-"));
  try { await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("type-safe registry supports explicit capabilities but refuses unknown and unsupported providers", () => {
  const registry = new ProviderRegistry();
  const runtime = { descriptor: provider, start: async () => "native" };
  registry.registerRuntime(runtime);
  assert.equal(registry.runtime("pi_durable", ["agent", "durable_replay"]).start,
    runtime.start);
  requireCapabilities(provider, ["provider_pi_durable_native_tasks"]);
  assert.throws(() => registry.runtime("pi_durable", ["signals"]), /Unsupported runtime capabilities/);
  assert.throws(() => registry.runtime("pi_durable", ["nonsense"]), /Unsupported runtime capabilities/);
  assert.throws(() => registry.runtime("regular_pi", ["agent"]), /Unknown runtime provider/);
  assert.throws(() => registry.registerRuntime(runtime), /Duplicate runtime provider/);
  assert.throws(() => registry.registerRuntime({
    descriptor: { ...provider, id: "regular_pi", capabilities: ["provider_pi_durable_native_tasks"] },
    start: async () => null,
  }), /foreign provider capability/);

  const executor = { descriptor: { ...provider, id: "sandbox", capabilities: ["dynamic_code"] as const },
    execute: async () => "ok" };
  registry.registerExecutor(executor);
  assert.equal(registry.executor("sandbox", ["dynamic_code"]), executor);
  assert.throws(() => registry.executor("sandbox", ["signals"]), /Unsupported runtime capabilities/);
});

test("publishing pins exact bytes, dependency versions and implementation, with immutable distinct revisions", async () =>
  inTemp(async directory => {
    const store = new FilePublicationStore(join(directory, "revisions"));
    const artifact = await fixture();
    // Independent store instances race to publish an identical revision. The
    // final path is atomically installed only once and never contains partial JSON.
    const publications = await Promise.all(Array.from({ length: 12 },
      () => new FilePublicationStore(join(directory, "revisions")).publish(artifact, binding)));
    const first = publications[0]!;
    assert.match(first.revisionId, /^[a-f0-9]{64}$/);
    assert.ok(publications.every(item => item.revisionId === first.revisionId));
    assert.deepEqual(await readdir(join(directory, "revisions")), [first.revisionId + ".json"],
      "temporary publication files must be cleaned up");
    assert.equal((await store.publish(artifact, binding)).revisionId, first.revisionId);
    assert.equal((await store.get(first.revisionId)).artifact.source, artifact.source);
    assert.deepEqual((await store.get(first.revisionId)).binding, binding);

    await assert.rejects(store.publish(artifact, { ...binding,
      resolvedDependencies: { "@earendil-works/pi-durable": "1.3.1" } }), /exact, installed pin/);
    await assert.rejects(store.publish(artifact, { ...binding, runtime: {
      ...provider, capabilities: ["agent"],
    } }), /Unsupported runtime capabilities/);

    // A capability-gated code escape hatch requires support on BOTH selected
    // components, not merely a valid code-executor descriptor.
    const dynamicArtifact = await loadWorkflow({
      source: artifact.source,
      manifestJson: JSON.stringify({
        ...artifact.manifest, requiredCapabilities: ["agent", "dynamic_code"],
      }),
    });
    const dynamicBinding = { ...binding, runtime: {
      ...provider, capabilities: ["agent", "dynamic_code"] as const,
    } };
    await assert.rejects(store.publish(dynamicArtifact, dynamicBinding),
      /Dynamic code requires an explicitly selected code executor/);
    const unsupportedExecutor = {
      id: "sandbox", version: "1.0.0", implementationSha256: "b".repeat(64), capabilities: [] as const,
    };
    await assert.rejects(store.publish(dynamicArtifact, {
      ...dynamicBinding, codeExecutor: unsupportedExecutor,
    }), /Unsupported runtime capabilities: dynamic_code/);
    const supported = await store.publish(dynamicArtifact, {
      ...dynamicBinding, codeExecutor: { ...unsupportedExecutor, capabilities: ["dynamic_code"] as const },
    });
    assert.equal((await store.get(supported.revisionId)).binding.codeExecutor?.capabilities[0], "dynamic_code");

    // Publication of later source is a *new* revision, never a rewrite.
    const newerSource = artifact.source + "\n// revised\n";
    const newer = await loadWorkflow({
      source: newerSource,
      manifestJson: JSON.stringify({
        ...artifact.manifest, version: "1.0.1", sourceSha256: await sha256(newerSource),
      }),
    });
    const second = await store.publish(newer, binding);
    assert.notEqual(first.revisionId, second.revisionId);
    assert.equal((await store.get(first.revisionId)).artifact.source, artifact.source);

    const path = join(directory, "revisions", first.revisionId + ".json");
    const record = JSON.parse(await readFile(path, "utf8"));
    record.files.source += "// tampered";
    await writeFile(path, JSON.stringify(record));
    await assert.rejects(store.get(first.revisionId), /content hash mismatch/);
    await assert.rejects(store.publish(artifact, binding), /content hash mismatch/);
  }));

test("published native runs retain provenance; mutable drafts and changed runtime descriptors cannot drift", async () =>
  inTemp(async directory => {
    const service = createWorkflowInvocationService({ cwd: directory, home: directory });
    const revisionId = await service.publish("dynamic_agents");
    const result = await service.runRevision(revisionId,
      { values: [1, -3, 2], requiresApproval: false });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.output, 6);

    // Both paths must hash the normalized input actually persisted in the
    // native task, independent of incoming JSON property insertion order.
    const reversed = { requiresApproval: false, values: [1, 2] };
    const byName = await service.run("dynamic_agents", reversed);
    const byRevision = await service.runRevision(revisionId, reversed);
    for (const completion of [byName, byRevision]) {
      assert.equal(completion.status, "completed");
      if (completion.status === "completed") assert.equal(completion.output, 6);
    }

    const { registry } = await trustedFixture({ approve: async () => true });
    const ctx = BACKGROUND_CONTEXT;
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, ".pi", "workflow-runs.sqlite")),
      { models: createModels(), registry }, ctx);
    try {
      const record = await harness.getTask(result.runId as TaskId<WorkflowOutcome>, ctx);
      assert.ok(record);
      const input = record.input as unknown as RunInput;
      assert.equal(input.publication?.revisionId, revisionId);
      assert.equal(input.publication?.runtime.id, "pi_durable");
      assert.match(input.publication!.runtime.implementationSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(input.publication?.dependencies, binding.resolvedDependencies);
      assert.equal(input.publication?.inputSha256, await sha256(JSON.stringify(input.input)));
      assert.match(input.publication!.configurationSha256, /^[a-f0-9]{64}$/);
    } finally { await harness.close(ctx); }

    const draft = join(directory, ".pi", "workflows", "dynamic_agents");
    await mkdir(draft, { recursive: true });
    await writeFile(join(draft, "workflow.ts"), "// changed mutable draft");
    await writeFile(join(draft, "workflow.json"),
      await readFile(new URL("../fixtures/complex/workflow.json", import.meta.url), "utf8"));
    await assert.rejects(service.run("dynamic_agents",
      { values: [1], requiresApproval: false }), /untrusted/);
    assert.equal((await service.runRevision(revisionId,
      { values: [2], requiresApproval: false })).status, "completed");

    const changedRuntime = createWorkflowInvocationService({
      cwd: directory, home: directory,
      capabilities: ["agent", "hooks", "approval", "dynamic_tasks"],
    });
    await assert.rejects(changedRuntime.runRevision(revisionId,
      { values: [1], requiresApproval: false }), /Published dependencies or runtime implementation changed/);
  }));
