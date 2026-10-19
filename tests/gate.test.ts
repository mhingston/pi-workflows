/**
 * Issue #6 release gate: ONE checked-in workflow package through UI projection,
 * both regular Pi entry points, and native Pi Durable checkpoint recovery.
 * No model provider or arbitrary code execution is required.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { exportWorkflow, loadWorkflow, refuseStructuralEdit, type WorkflowFiles } from "../src/artifact.ts";
import { projectWorkflow } from "../src/editor.ts";
import { startEditor } from "../src/editor-server.ts";
import { createWorkflowInvocationService } from "../src/invocation.ts";
import { registerWorkflowExtension } from "../src/pi-extension.ts";
import { trustedFixture } from "./support/trusted-fixture.ts";
import type { RunInput, WorkflowOutcome } from "../src/durable/fixture-runtime.ts";

const ctx = BACKGROUND_CONTEXT;
type Invocation = { status: string; runId: number; output?: number; effectKey?: string };
type State = {
  revision: number;
  dirty: boolean;
  files: WorkflowFiles;
  graph: { nodes: Array<{ id: string; category: string; kind: string }>; edges: unknown[] };
};

async function inTemp(fn: (dir: string, packageDir: string, initial: WorkflowFiles) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-gate-"));
  const packageDir = join(dir, ".pi", "workflows", "dynamic_agents");
  try {
    await mkdir(packageDir, { recursive: true });
    const source = await readFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), "utf8");
    const manifestJson = await readFile(new URL("../fixtures/complex/workflow.json", import.meta.url), "utf8");
    await writeFile(join(packageDir, "workflow.ts"), source);
    await writeFile(join(packageDir, "workflow.json"), manifestJson);
    await fn(dir, packageDir, { source, manifestJson });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function post(base: string, revision: number, type: string, fields: object = {}) {
  return fetch(base + "/api/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workflow-editor": "1" },
    body: JSON.stringify({ type, revision, ...fields }),
  });
}

function piEntryPoints(service: ReturnType<typeof createWorkflowInvocationService>, cwd: string) {
  const notices: Array<{ message: string; level: string }> = [];
  let confirmations = 0;
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let tool: ((id: string, p: { name: string; input: { values: number[]; requiresApproval: boolean } },
    signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) =>
    Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>) | undefined;
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    registerTool: (options: { execute: typeof tool }) => { tool = options.execute; },
    getCommands: () => [{ name: "workflow" }],
    on: () => () => {},
  } as unknown as ExtensionAPI;
  const piContext = {
    cwd, hasUI: true, isProjectTrusted: () => true,
    ui: {
      notify: (message: string, level: string) => { notices.push({ message, level }); },
      confirm: async () => { confirmations++; return true; },
    },
  } as unknown as ExtensionContext;
  registerWorkflowExtension(pi, () => service);
  assert.ok(command && tool);
  return {
    async viaCommand(input: { values: number[]; requiresApproval: boolean }): Promise<Invocation> {
      await command!("run dynamic_agents --input-json " + JSON.stringify(input), piContext);
      const notice = notices.at(-1);
      assert.equal(notice?.level, "info", notice?.message);
      return JSON.parse(notice!.message) as Invocation;
    },
    async viaTool(input: { values: number[]; requiresApproval: boolean }): Promise<Invocation> {
      const result = await tool!("gate", { name: "dynamic_agents", input }, undefined, undefined, piContext);
      const value = JSON.parse(result.content[0]!.text) as Invocation;
      assert.deepEqual(result.details, value);
      return value;
    },
    confirmationCount: () => confirmations,
  };
}

test("release gate: same package -> offline viewer/no-op save -> Pi command & tool -> durable records", async () =>
  inTemp(async (dir, packageDir, initial) => {
    const before = await loadWorkflow(initial);
    let editor: Awaited<ReturnType<typeof startEditor>> | undefined;
    try {
      editor = await startEditor(packageDir, 0);
      const address = editor.address();
      assert.ok(address && typeof address !== "string");
      const base = "http://127.0.0.1:" + address.port;
      let view = await fetch(base + "/api/state").then(r => r.json()) as State;
      for (const category of ["branch", "parallel", "dynamic", "opaque", "call"]) {
        assert.ok(view.graph.nodes.some(n => n.category === category), category + " missing from viewer");
      }
      assert.deepEqual(view.graph.edges, [], "dynamic tasks must not invent executable static edges");
      assert.deepEqual(view.files, initial);
      const saved = await post(base, view.revision, "save");
      const savedText = await saved.text();
      assert.equal(saved.status, 200, savedText);
      view = JSON.parse(savedText) as State;
      assert.equal(view.dirty, false);
      assert.equal(await readFile(join(packageDir, "workflow.ts"), "utf8"), initial.source);
      assert.equal(await readFile(join(packageDir, "workflow.json"), "utf8"), initial.manifestJson);

      const dynamic = view.graph.nodes.find(n => n.category === "dynamic")!;
      const forbidden = await post(base, view.revision, "property", { id: dynamic.id, value: "unsafe" });
      assert.equal(forbidden.status, 400, "unsupported visual rewrites must fail");
      assert.throws(() => refuseStructuralEdit(before, { remove: dynamic.id }), /unsafe visual edit/);

      const movedResponse = await post(base, view.revision, "move", { id: dynamic.id, x: 432, y: 210 });
      const movedResponseText = await movedResponse.text();
      assert.equal(movedResponse.status, 200, movedResponseText);
      view = JSON.parse(movedResponseText) as State;
      const moveSave = await post(base, view.revision, "save");
      const moveSaveText = await moveSave.text();
      assert.equal(moveSave.status, 200, moveSaveText);
      view = JSON.parse(moveSaveText) as State;
      const roundTrip = await loadWorkflow({
        source: await readFile(join(packageDir, "workflow.ts"), "utf8"),
        manifestJson: await readFile(join(packageDir, "workflow.json"), "utf8"),
        layoutJson: await readFile(join(packageDir, "layout.json"), "utf8"),
      });
      assert.equal(roundTrip.source, initial.source, "layout save may not rewrite executable TS");
      assert.equal(roundTrip.manifest.sourceSha256, before.manifest.sourceSha256);
      assert.equal((await projectWorkflow(roundTrip)).nodes.find(n => n.id === dynamic.id)?.x, 432);
      assert.deepEqual(exportWorkflow(roundTrip), view.files);
    } finally {
      if (editor) {
        const running = editor;
        await new Promise<void>((resolve, reject) =>
          running.close(err => err ? reject(err) : resolve()));
      }
    }

    let effects = 0;
    const service = createWorkflowInvocationService({
      cwd: dir, home: dir, fixtureEffect: { approve: async () => { effects++; return true; } },
    });
    const pi = piEntryPoints(service, dir);
    const input = { values: [2, -4, 3], requiresApproval: true };
    const command = await pi.viaCommand(input);
    const tool = await pi.viaTool(input);
    assert.deepEqual([command.status, command.output], ["completed", 10]);
    assert.deepEqual([tool.status, tool.output], ["completed", 10]);
    assert.notEqual(command.runId, tool.runId);
    assert.equal(pi.confirmationCount(), 2, "each Pi entry point independently authorizes");
    assert.equal(effects, 2, "one authorized effect per run");

    // Inspect native Pi Durable task inputs/outcomes: never trust an API response
    // as evidence of a durable source/consent pin.
    const { registry } = await trustedFixture({ approve: async () => { throw new Error("must not replay"); } });
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(dir, ".pi", "workflow-runs.sqlite")),
      { models: createModels(), registry }, ctx,
    );
    try {
      for (const run of [command, tool]) {
        const record = await harness.getTask(run.runId as TaskId<WorkflowOutcome>, ctx);
        assert.ok(record, "native run record missing");
        const metadata = record.input as unknown as RunInput;
        assert.equal(metadata.workflowId, "dynamic_agents");
        assert.equal(metadata.workflowVersion, "1.0.0");
        assert.equal(metadata.sourceSha256, before.manifest.sourceSha256);
        assert.equal(metadata.interactiveApproval, "approved");
        assert.equal(record.state.status, "terminal");
        if (record.state.status === "terminal" && record.state.outcome.status === "completed") {
          const result = record.state.outcome.result;
          assert.equal(result.status, "completed");
          if (result.status === "completed") {
            assert.equal(result.output, 10);
            assert.equal(result.workflowVersion, metadata.workflowVersion);
            assert.equal(result.sourceSha256, metadata.sourceSha256);
            assert.deepEqual(result.steps.map(step => step.input), [2, 3]);
            assert.equal(new Set(result.steps.map(step => step.taskId)).size, 2);
          }
        } else {
          assert.fail("expected native completed run record");
        }
      }
    } finally { await harness.close(ctx); }
    console.log("GO evidence: same SHA, UI round-trip, 2 Pi entry points, native run IDs, child receipts and consent persisted");
  }));

test("release gate: native parent resumes mid-parallel join, records source pin and approval decision", async () =>
  inTemp(async (_dir, _packageDir, initial) => {
    const artifact = await loadWorkflow(initial);
    const dbDir = await mkdtemp(join(tmpdir(), "pi-workflow-gate-recovery-"));
    const db = join(dbDir, "recovery.sqlite");
    let approvals = 0;
    const { Run, registry, input } = await trustedFixture({
      approve: async () => { approvals++; return true; },
    });
    const open = async () => Harness.open(await openNodeSqliteStorage(db),
      { models: createModels(), registry }, ctx);
    let harness = await open();
    try {
      const root = await harness.root(ctx);
      const id = await root.commit(tx => tx.createTask(Run, input([1, -9, 2, 4], true),
        { ownership: { kind: "conversation" } }), ctx);
      harness.resume();
      let persistedWait = false;
      for (let i = 0; i < 100; i++) {
        const record = await harness.getTask(id, ctx);
        if (record?.state.status === "waiting") { persistedWait = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(persistedWait, "parent must reach native child join checkpoint before restart");
      await harness.close(ctx);
      harness = await open();
      const settled = await harness.waitForTask(id, ctx);
      assert.equal(settled.state.outcome.status, "completed");
      if (settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result;
        assert.equal(result.status, "completed");
        if (result.status === "completed") {
          assert.equal(result.output, 14);
          assert.equal(result.workflowVersion, artifact.manifest.version);
          assert.equal(result.sourceSha256, artifact.manifest.sourceSha256);
          assert.deepEqual(result.steps.map(step => step.input), [1, 2, 4]);
        }
      }
      assert.equal(approvals, 1, "approval effect should happen only once after restart");
      const record = await harness.getTask(id, ctx);
      assert.ok(record);
      const savedInput = record.input as unknown as RunInput;
      assert.equal(savedInput.sourceSha256, artifact.manifest.sourceSha256);
      assert.equal(savedInput.interactiveApproval, "not_recorded",
        "direct native tasks are not evidence of Pi UI consent");
      console.log("GO evidence: persisted native child join resumed on reopen with one approval effect");
    } finally {
      await harness.close(ctx).catch(() => {});
      await rm(dbDir, { recursive: true, force: true });
    }
  }));

test("release gate: capabilities fail closed and ambiguous non-idempotent effects never report success", async () =>
  inTemp(async (dir, _packageDir, initial) => {
    const limited = createWorkflowInvocationService({ cwd: dir, home: dir, capabilities: ["agent", "hooks"] });
    await assert.rejects(limited.run("dynamic_agents", { values: [1], requiresApproval: false }),
      /Unsupported runtime capabilities/);
    const db = join(dir, ".pi", "workflow-runs.sqlite");
    await assert.rejects(readFile(db), "capability rejection must not create a native task database");
    let calls = 0;
    const service = createWorkflowInvocationService({
      cwd: dir, home: dir,
      fixtureEffect: { approve: async () => { calls++; throw new Error("effect may have happened"); } },
    });
    const result = await service.run("dynamic_agents", { values: [2, 3], requiresApproval: true },
      { authorize: async () => true });
    assert.equal(result.status, "needs_reconciliation");
    assert.equal(calls, 1, "ambiguous external effect must not be retried");
    if (result.status === "needs_reconciliation") {
      assert.ok(result.effectKey.startsWith((await loadWorkflow(initial)).manifest.sourceSha256));
      const { registry } = await trustedFixture({
        approve: async () => { throw new Error("reopened store cannot repeat effect"); },
      });
      const harness = await Harness.open(await openNodeSqliteStorage(db),
        { models: createModels(), registry }, ctx);
      try {
        const record = await harness.getTask(result.runId as TaskId<WorkflowOutcome>, ctx);
        assert.ok(record);
        const stored = record.input as unknown as RunInput;
        assert.equal(stored.interactiveApproval, "approved");
        assert.equal(record?.state.status, "terminal");
        if (record?.state.status === "terminal" && record.state.outcome.status === "completed") {
          assert.equal(record.state.outcome.result.status, "needs_reconciliation");
        } else assert.fail("expected durable needs_reconciliation outcome");
      } finally { await harness.close(ctx); }
    }
    console.log("GO evidence: unsupported capabilities rejected; uncertain effect has durable reconciliation receipt");
  }));
