import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { exportWorkflow, loadWorkflow, sha256, type LoadedWorkflow } from "../src/artifact.ts";
import { canvasOrder, editCanvas, readCanvas } from "../src/canvas.ts";
import { projectWorkflow } from "../src/editor.ts";
import { startEditor } from "../src/editor-server.ts";

const source = await readFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../fixtures/complex/workflow.json", import.meta.url), "utf8")) as Record<string, unknown>;
async function load(sourceText = source): Promise<LoadedWorkflow> {
  return loadWorkflow({ source: sourceText, manifestJson: JSON.stringify({
    ...manifest, sourceSha256: await sha256(sourceText),
  }) });
}
async function withArms() {
  const first = await editCanvas(await load(), { type: "add-branch", x: 150, y: 100 });
  const branchId = readCanvas(first.source)!.branch!.id;
  const trueStep = await editCanvas(first, { type: "add-step", kind: "hook", name: "true-path", x: 420, y: 80 });
  const trueId = readCanvas(trueStep.source)!.steps[0]!.id;
  const inTrue = await editCanvas(trueStep, { type: "connect-branch", from: branchId, to: trueId, arm: "then" });
  const falseStep = await editCanvas(inTrue, { type: "add-step", kind: "hook", name: "false-path", x: 420, y: 270 });
  const falseId = readCanvas(falseStep.source)!.steps.find(s => s.name === "false-path")!.id;
  const both = await editCanvas(falseStep, { type: "connect-branch", from: branchId, to: falseId, arm: "else" });
  return { both, branchId, trueId, falseId };
}

test("typed branch ports map to real if/else source and stable source-derived edges", async () => {
  const original = await load();
  const { both, branchId, trueId, falseId } = await withArms();
  const managed = readCanvas(both.source)!;
  assert.equal(managed.branch?.id, branchId);
  assert.deepEqual(managed.branch?.then.map(s => s.id), [trueId]);
  assert.deepEqual(managed.branch?.else.map(s => s.id), [falseId]);
  assert.equal(managed.steps.find(s => s.id === trueId)?.lane, "then");
  assert.equal(managed.steps.find(s => s.id === falseId)?.lane, "else");
  assert.match(both.source, /if \(input\.requiresApproval\) \{/);
  assert.match(both.source, /} else \{/);
  assert.equal(both.source.slice(0, managed.start), original.source.slice(0, readCanvas(original.source)!.start));
  assert.equal(both.source.slice(managed.end), original.source.slice(readCanvas(original.source)!.end),
    "unknown callback and dynamic fan-out stay byte-for-byte unchanged");
  const edges = canvasOrder(both.source);
  assert.ok(edges.some(e => e.from === branchId && e.to === trueId && e.kind === "then"));
  assert.ok(edges.some(e => e.from === branchId && e.to === falseId && e.kind === "else"));
  const graph = await projectWorkflow(both);
  assert.ok(graph.nodes.some(n => n.id === branchId && n.canvasBranch));
  assert.equal(graph.nodes.find(n => n.id === trueId)?.lane, "then");
  assert.deepEqual(exportWorkflow(await loadWorkflow(exportWorkflow(both))), exportWorkflow(both),
    "full package no-op preserves every byte");
  assert.equal(graph.edges.length, 0, "no runtime edges are invented");
});

test("branch rewrite moves steps between lanes, adds a real join, and restores source on removal", async () => {
  const { both, branchId, trueId, falseId } = await withArms();
  const post = await editCanvas(both, { type: "add-step", kind: "agent", name: "after-if", x: 750, y: 180 });
  const postId = readCanvas(post.source)!.steps.find(s => s.name === "after-if")!.id;
  const flows = canvasOrder(post.source);
  assert.ok(flows.some(e => e.from === trueId && e.to === postId && e.kind === "join"));
  assert.ok(flows.some(e => e.from === falseId && e.to === postId && e.kind === "join"));
  const switched = await editCanvas(post, { type: "connect-branch", from: branchId, to: trueId, arm: "else" });
  assert.deepEqual(readCanvas(switched.source)!.branch?.else.map(s => s.id), [falseId, trueId]);
  assert.deepEqual(readCanvas(switched.source)!.branch?.then.map(s => s.id), []);
  const disconnected = await editCanvas(switched, { type: "disconnect-branch", id: trueId });
  assert.equal(readCanvas(disconnected.source)!.steps.find(s => s.id === trueId)?.lane, "top");
  const renamed = await editCanvas(disconnected, { type: "rename-step", id: falseId, name: "changed" });
  assert.equal(readCanvas(renamed.source)!.steps.find(s => s.id === falseId)?.name, "changed");
  let cleared = renamed;
  for (const id of [postId, trueId, falseId]) cleared = await editCanvas(cleared, { type: "remove-step", id });
  cleared = await editCanvas(cleared, { type: "remove-branch", id: branchId });
  assert.equal(cleared.source, source, "removing the managed construct restores original source exactly");
  assert.equal(cleared.manifest.sourceSha256, await sha256(source));
});

test("generated TypeScript executes conditional paths with trusted fixture ports", async () => {
  const { both, branchId } = await withArms();
  const approval = await editCanvas(both, { type: "add-step", kind: "approval", name: "gate", x: 500, y: 160 });
  const id = readCanvas(approval.source)!.steps.find(s => s.name === "gate")!.id;
  const gated = await editCanvas(approval, { type: "connect-branch", from: branchId, to: id, arm: "then" });
  // This is an in-test execution of the generated trusted fixture module,
  // NOT a Pi Durable invocation or permission to import browser-authored code.
  const js = ts.transpileModule(gated.source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64")) as {
    runWorkflow: (input: { values: number[]; requiresApproval: boolean }, ports: {
      agent: (name: string, input: number) => Promise<number>;
      hook: (name: string, input: unknown) => Promise<void>;
      approve: (name: string) => Promise<boolean>;
    }) => Promise<number>;
  };
  const calls: string[] = [];
  const ports = {
    agent: async (_name: string, v: number) => v,
    hook: async (name: string, _value: unknown) => { calls.push(name); },
    approve: async (name: string) => { calls.push(name); return true; },
  };
  await module.runWorkflow({ values: [], requiresApproval: true }, ports);
  assert.deepEqual(calls, ["before", "true-path", "gate", "after"]);
  calls.length = 0;
  await module.runWorkflow({ values: [], requiresApproval: false }, ports);
  assert.deepEqual(calls, ["before", "false-path", "after"]);
  await assert.rejects(module.runWorkflow({ values: [], requiresApproval: true },
    { ...ports, approve: async () => false }), /approval denied/);
});

test("unsupported graph shapes, ambiguous anchors and opaque code are rejected", async () => {
  const { both, branchId, trueId, falseId } = await withArms();
  await assert.rejects(editCanvas(both, { type: "connect-step", from: trueId, to: falseId }), /cross-lane/);
  await assert.rejects(editCanvas(both, { type: "connect-step", from: trueId, to: trueId }), /different managed/);
  await assert.rejects(editCanvas(both, { type: "remove-branch", id: branchId }), /disconnect branch steps/);
  await assert.rejects(editCanvas(both, { type: "add-branch", x: 40, y: 40 }), /only one/);
  await assert.rejects(editCanvas(both, { type: "connect-branch", from: branchId, to: trueId, arm: "bogus" as "then" }), /unsupported branch output/);
  await assert.rejects(editCanvas(both, { type: "connect-branch", from: branchId, to: "ast_hook_1", arm: "then" }), /unknown managed/);
  const modified = both.source.replace("if (input.requiresApproval) {", "if (input.requiresApproval && extra()) {");
  await assert.rejects(projectWorkflow(await load(modified)), /unrecognized code in canvas region/);
  const changedCallback = both.source.replace('await ports.hook("true-path", input);',
    'await ports.hook(getName(), input);');
  await assert.rejects(editCanvas(await load(changedCallback),
    { type: "remove-step", id: falseId }), /unsupported statement/);
  const duplicate = both.source.replace(falseId, trueId);
  await assert.rejects(projectWorkflow(await load(duplicate)), /duplicate managed id/);
  const moved = await editCanvas(both, { type: "rename-step", id: trueId, name: "renamed" });
  const layout = JSON.parse(moved.files.layoutJson!) as {
    nodes: Array<{ id: string; anchor?: { start: number; end: number; sha256: string } }>;
  };
  const affected = layout.nodes.find(n => n.id === trueId)!;
  affected.anchor!.start++;
  await assert.rejects(loadWorkflow({ ...moved.files, layoutJson: JSON.stringify(layout) }), /anchor is stale/);
});

test("HTTP branch connections honor revision checks and persist canonical TypeScript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-branch-canvas-"));
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    const input = await load();
    await writeFile(join(dir, "workflow.ts"), input.source);
    await writeFile(join(dir, "workflow.json"), input.files.manifestJson);
    server = await startEditor(dir, 0);
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const base = "http://127.0.0.1:" + addr.port;
    const post = async (revision: number, type: string, fields: Record<string, unknown> = {}) => {
      const response = await fetch(base + "/api/action", {
        method: "POST", headers: { "content-type": "application/json", "x-workflow-editor": "1" },
        body: JSON.stringify({ revision, type, ...fields }),
      });
      return { status: response.status, data: await response.json() as Record<string, any> };
    };
    const created = await post(0, "add-branch", { x: 80, y: 80 });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const branchId = created.data.graph.nodes.find((n: any) => n.canvasBranch).id as string;
    const added = await post(1, "add-step", { kind: "hook", name: "true", x: 400, y: 90 });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    const id = added.data.graph.nodes.find((n: any) => n.canvasKind === "hook").id as string;
    const stale = await post(1, "connect-branch", { from: branchId, to: id, arm: "then" });
    assert.equal(stale.status, 409);
    const connected = await post(2, "connect-branch", { from: branchId, to: id, arm: "then" });
    assert.equal(connected.status, 200, JSON.stringify(connected.data));
    assert.ok(connected.data.graph.sequenceEdges.some((e: any) => e.kind === "then"));
    const saved = await post(3, "save");
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const stored = await readFile(join(dir, "workflow.ts"), "utf8");
    assert.match(stored, /if \(input\.requiresApproval\) \{[\s\S]*await ports\.hook\("true", input\);/);
    const artifact = await loadWorkflow({
      source: stored, manifestJson: await readFile(join(dir, "workflow.json"), "utf8"),
      layoutJson: await readFile(join(dir, "layout.json"), "utf8"),
    });
    assert.equal(readCanvas(artifact.source)!.branch?.then[0]?.id, id);
  } finally {
    if (server) await new Promise<void>((ok, bad) => server!.close(err => err ? bad(err) : ok()));
    await rm(dir, { recursive: true, force: true });
  }
});
