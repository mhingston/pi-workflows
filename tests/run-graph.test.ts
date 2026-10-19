/**
 * Issue #8: native correlation contract and optional builder view. The test
 * uses real Pi Durable SQLite records; there is no fake trace/event bus.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { captureRunGraph } from "../src/durable/run-graph.ts";
import { startEditor } from "../src/editor-server.ts";
import { trustedFixture } from "./support/trusted-fixture.ts";
import type { WorkflowOutcome } from "../src/durable/fixture-runtime.ts";

const ctx = BACKGROUND_CONTEXT;

test("native parent and child IDs survive a persisted wait, reopen, and terminal settlement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-correlation-"));
  const { Run, registry, input, artifact } = await trustedFixture({
    approve: async () => true,
  });
  const open = () => Harness.open(awaitStorage(), { models: createModels(), registry }, ctx);
  const awaitStorage = () => openNodeSqliteStorage(join(dir, "runs.sqlite"));
  let harness = await open();
  try {
    const root = await harness.root(ctx);
    const id = await root.commit(
      tx => tx.createTask(Run, input([2, -10, 3, 4], false), { ownership: { kind: "conversation" } }),
      ctx,
    );
    harness.resume();
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const record = await harness.getTask(id, ctx);
      if (record?.state.status === "waiting") { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(waiting, "must observe persisted join, not infer children from the source");

    const during = await captureRunGraph(harness, Number(id));
    assert.ok(during);
    assert.equal(during.runId, Number(id));
    assert.equal(during.workflowId, artifact.manifest.id);
    assert.equal(during.workflowVersion, artifact.manifest.version);
    assert.equal(during.sourceSha256, artifact.manifest.sourceSha256);
    assert.equal(during.nodes.length, 4);
    assert.equal(during.nodes[0]?.status, "waiting");
    assert.deepEqual(during.edges.map(edge => edge.from), [Number(id), Number(id), Number(id)]);
    const children = during.edges.map(edge => edge.to);
    assert.equal(new Set(children).size, 3);
    assert.ok(during.nodes.every(node => node.conversationId === during.conversationId));

    await harness.close(ctx);
    harness = await open();
    const reopened = await captureRunGraph(harness, Number(id));
    assert.ok(reopened);
    assert.deepEqual(reopened.edges, during.edges, "reopen must not assign fresh native IDs");
    assert.deepEqual(reopened.nodes.map(node => node.taskId), during.nodes.map(node => node.taskId));
    const settled = await harness.waitForTask(id, ctx);
    assert.equal(settled.state.outcome.status, "completed");
    const finished = await captureRunGraph(harness, Number(id));
    assert.ok(finished);
    assert.equal(finished.nodes[0]?.status, "terminal");
    assert.equal(finished.nodes[0]?.outcome, "completed");
    assert.deepEqual(finished.edges, during.edges, "terminal task graph must use durable child receipts");
    assert.ok(finished.nodes.slice(1).every(node => node.status === "terminal"));
    const live = await harness.watchTaskGraph(ctx);
    try {
      assert.ok(!live.value.tasks[String(id)], "terminal tasks must NOT be claimed as live");
    } finally { await live.stop(); }
    assert.equal(await captureRunGraph(harness, Number(id) + 100000), null);
  } finally {
    await harness.close(ctx).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("builder reads the owner's native snapshot without any telemetry provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-editor-run-"));
  const { Run, registry, input } = await trustedFixture({ approve: async () => true });
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "runs.sqlite")),
    { models: createModels(), registry }, ctx);
  const fixtureDir = new URL("../fixtures/complex/", import.meta.url).pathname;
  let editor: Awaited<ReturnType<typeof startEditor>> | undefined;
  let unconnected: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    const root = await harness.root(ctx);
    const id = await root.commit(tx =>
      tx.createTask(Run, input([1, 2], false), { ownership: { kind: "conversation" } }), ctx);
    await harness.waitForTask(id, ctx);
    editor = await startEditor(fixtureDir, 0, { runGraph: n => captureRunGraph(harness, n) });
    const address = editor.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const loaded = await fetch(base + "/api/run-graph?runId=" + Number(id));
    assert.equal(loaded.status, 200);
    const graph = await loaded.json() as { runId: number; nodes: unknown[]; edges: unknown[] };
    assert.equal(graph.runId, Number(id));
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 2);
    assert.equal((await fetch(base + "/api/run-graph?runId=nope")).status, 400);
    assert.equal((await fetch(base + "/api/run-graph?runId=0")).status, 400);
    assert.equal((await fetch(base + "/api/run-graph?runId=9007199254740999")).status, 400);
    assert.equal((await fetch(base + "/api/run-graph?runId=999999")).status, 404);

    unconnected = await startEditor(fixtureDir, 0);
    const other = unconnected.address();
    assert.ok(other && typeof other !== "string");
    assert.equal((await fetch("http://127.0.0.1:" + other.port + "/api/run-graph?runId=" + Number(id))).status, 503);
  } finally {
    if (editor) await new Promise<void>((resolve, reject) => editor!.close(e => e ? reject(e) : resolve()));
    if (unconnected) await new Promise<void>((resolve, reject) => unconnected!.close(e => e ? reject(e) : resolve()));
    await harness.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
