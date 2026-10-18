import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ArtifactError, exportWorkflow, loadWorkflow, moveNode,
  refuseStructuralEdit, sha256, type WorkflowFiles,
  type WorkflowManifest, type WorkflowLayout,
} from "../src/artifact.ts";

const source = await readFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), "utf8");

async function fixture(): Promise<WorkflowFiles> {
  const hash = await sha256(source);
  const marked = "const mapped = (n: number) => n * 2;";
  const start = source.indexOf(marked);
  assert.ok(start >= 0, "fixture includes source anchor");
  const manifest: WorkflowManifest = {
    schemaVersion: 1,
    id: "dynamic_agents",
    version: "1.0.0",
    entrypoint: "workflow.ts",
    sourceSha256: hash,
    inputSchema: { type: "object", required: ["values"] },
    outputSchema: { type: "number" },
    requiredCapabilities: ["agent", "hooks", "approval", "dynamic_tasks"],
    dependencies: { "@earendil-works/pi-durable": "1.3.0" },
  };
  const layout: WorkflowLayout = {
    schemaVersion: 1,
    sourceSha256: hash,
    nodes: [
      { id: "loop", kind: "dynamic", label: "Runtime fan-out", x: 20, y: 50 },
      { id: "callback", kind: "known", label: "Callback (anchored)", x: 180, y: 50,
        anchor: { start, end: start + marked.length, sha256: await sha256(marked) } },
      { id: "custom", kind: "opaque", label: "Arbitrary TS", x: 280, y: 80 },
    ],
    edges: [
      { id: "hint", from: "loop", to: "callback", kind: "illustrative" },
    ],
  };
  // Intentionally irregular formatting demonstrates byte-for-byte no-op saves.
  return {
    source,
    manifestJson: JSON.stringify(manifest, null, 4) + "\n",
    layoutJson: JSON.stringify(layout, null, 2) + "\n",
  };
}

test("no-op import -> export -> import retains all source and JSON bytes", async () => {
  const files = await fixture();
  const loaded = await loadWorkflow(files);
  const exported = exportWorkflow(loaded);
  assert.deepEqual(exported, files);
  assert.deepEqual(exportWorkflow(await loadWorkflow(exported)), files);
  assert.match(loaded.source, /Promise\.all/);
  assert.match(loaded.source, /ports\.approve/);
  assert.match(loaded.source, /ports\.hook/);
  assert.match(loaded.source, /const mapped/);
});

test("cosmetic layout editing does not touch canonical source or manifest", async () => {
  const files = await fixture();
  const moved = await moveNode(await loadWorkflow(files), "loop", 90, 140);
  assert.equal(moved.source, files.source);
  assert.equal(moved.files.manifestJson, files.manifestJson);
  assert.equal(moved.layout?.nodes[0]?.x, 90);
  assert.equal(moved.layout?.nodes[0]?.y, 140);
  assert.equal(moved.layout?.nodes[0]?.kind, "dynamic");
  assert.equal(moved.layout?.edges[0]?.kind, "illustrative");
  assert.deepEqual(exportWorkflow(await loadWorkflow(exportWorkflow(moved))), exportWorkflow(moved));
});

test("reject mismatched source hash and stale layout, never silently repair", async () => {
  const files = await fixture();
  await assert.rejects(loadWorkflow({ ...files, source: files.source + "\n// changed" }),
    /checksum does not match/);
  const newSource = files.source + "\n// changed";
  const manifest = JSON.parse(files.manifestJson) as WorkflowManifest;
  await assert.rejects(loadWorkflow({
    source: newSource,
    manifestJson: JSON.stringify({ ...manifest, sourceSha256: await sha256(newSource) }),
    layoutJson: files.layoutJson,
  }), /layout is stale/);
});

test("reject stale anchored source span", async () => {
  const files = await fixture();
  const layout = JSON.parse(files.layoutJson!) as { nodes: Array<{ anchor?: { sha256: string } }> };
  layout.nodes[1]!.anchor!.sha256 = "a".repeat(64);
  await assert.rejects(loadWorkflow({ ...files, layoutJson: JSON.stringify(layout) }), /anchor is stale/);
});

test("dynamic regions have no invented executable static edges", async () => {
  const files = await fixture();
  const layout = JSON.parse(files.layoutJson!) as { edges: Array<{ kind: string }> };
  layout.edges[0]!.kind = "runtime";
  await assert.rejects(loadWorkflow({ ...files, layoutJson: JSON.stringify(layout) }), /illustrative/);
});

test("reject unsafe graph changes and invalid position values", async () => {
  const workflow = await loadWorkflow(await fixture());
  assert.throws(() => refuseStructuralEdit(workflow, { removeNode: "custom" }), ArtifactError);
  await assert.rejects(moveNode(workflow, "loop", Number.NaN, 5), /finite/);
  await assert.rejects(moveNode(workflow, "absent", 0, 0), /unknown node/);
});

test("reject schema drift and duplicate node identifiers", async () => {
  const files = await fixture();
  const manifest = JSON.parse(files.manifestJson) as Record<string, unknown>;
  await assert.rejects(loadWorkflow({
    ...files, manifestJson: JSON.stringify({ ...manifest, schemaVersion: 2 }),
  }), /unsupported manifest/);
  await assert.rejects(loadWorkflow({
    ...files, manifestJson: JSON.stringify({ ...manifest, extra: "would be discarded" }),
  }), /unsupported property/);
  const layout = JSON.parse(files.layoutJson!) as { nodes: Array<{ id: string }> };
  layout.nodes[1]!.id = "loop";
  await assert.rejects(loadWorkflow({ ...files, layoutJson: JSON.stringify(layout) }), /duplicate node/);
});

test("trusted fixture behaves identically after no-op source round-trip", async () => {
  // Node's TS stripping executes only this trusted, committed fixture.
  // The artifact loader does not import/evaluate arbitrary workflow text.
  const exported = exportWorkflow(await loadWorkflow(await fixture()));
  const folder = await mkdtemp(join(tmpdir(), "pi-workflow-artifact-"));
  try {
    const copy = join(folder, "roundtrip.mts");
    await writeFile(copy, exported.source, "utf8");
    const original = await import("../fixtures/complex/workflow.ts");
    const restored = await import(pathToFileURL(copy).href) as typeof original;
    async function run(fn: typeof original.runWorkflow, approve: boolean): Promise<{
      result: number; calls: string[];
    }> {
      const calls: string[] = [];
      const result = await fn({ values: [1, -9, 2, 3], requiresApproval: true }, {
        agent: async (name, value) => { calls.push(name + ":" + value); return value; },
        hook: async name => { calls.push("hook:" + name); },
        approve: async () => { calls.push("approved"); return approve; },
      });
      return { result, calls };
    }
    assert.deepEqual(await run(original.runWorkflow, true), await run(restored.runWorkflow, true));
    assert.deepEqual((await run(restored.runWorkflow, true)).result, 12);
    await assert.rejects(run(restored.runWorkflow, false), /approval denied/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
