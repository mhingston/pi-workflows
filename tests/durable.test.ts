import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { trustedFixture } from "./support/trusted-fixture.ts";
import type { WorkflowOutcome } from "../src/durable/fixture-runtime.ts";

const ctx = BACKGROUND_CONTEXT;

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflows-durable-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("native child tasks, conditional dynamic fan-out and controlled recovery", async () => inTemp(async dir => {
  const db = join(dir, "session.sqlite");
  let approvals = 0;
  const { Run, registry, input, artifact } = await trustedFixture({
    approve: async () => { approvals++; return true; },
  });
  const open = async () => Harness.open(await openNodeSqliteStorage(db),
    { models: createModels(), registry }, ctx);
  let harness = await open();
  try {
    const root = await harness.root(ctx);
    const id = await root.commit(tx => tx.createTask(Run, input([1, -8, 2, 3], false),
      { ownership: { kind: "conversation" } }), ctx);
    harness.resume();
    // Stop at a real persisted waiting checkpoint, not a guessed timeout.
    let waitReached = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await harness.getTask(id, ctx);
      if (record?.state.status === "waiting") { waitReached = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(waitReached, "parent never durably joined child tasks");
    await harness.close(ctx);
    harness = await open();
    const settled = await harness.waitForTask(id, ctx);
    assert.equal(settled.state.outcome.status, "completed");
    if (settled.state.outcome.status === "completed") {
      const result = settled.state.outcome.result;
      assert.equal(result.status, "completed");
      if (result.status === "completed") {
        assert.equal(result.output, 12);
        assert.equal(result.steps.length, 3);
        assert.deepEqual(result.steps.map(s => s.input), [1, 2, 3]);
        assert.deepEqual(result.steps.map(s => s.result), [1, 2, 3]);
        assert.equal(new Set(result.steps.map(s => s.taskId)).size, 3);
        assert.equal(result.sourceSha256, artifact.manifest.sourceSha256);
        assert.equal(result.workflowVersion, "1.0.0");
      }
    }
    assert.equal(approvals, 0, "no approval necessary");
    const record = await harness.getTask(id, ctx);
    const storedInput = record?.input;
    assert.ok(storedInput && typeof storedInput === "object" && !Array.isArray(storedInput));
    assert.equal(storedInput.sourceSha256, artifact.manifest.sourceSha256);
    console.log("PASS: parent + 3 native children resumed, output 12; no duplicate child receipts");
  } finally {
    await harness.close(ctx).catch(() => {});
  }
}));

test("rejects unregistered workflow revision before executing child tasks", async () => inTemp(async dir => {
  const { Run, registry, input } = await trustedFixture({
    approve: async () => { throw new Error("should not run approval"); },
  });
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")),
    { models: createModels(), registry }, ctx);
  try {
    const root = await harness.root(ctx);
    const id = await root.commit(
      tx => tx.createTask(Run, { ...input([1], false), sourceSha256: "f".repeat(64) },
        { ownership: { kind: "conversation" } }), ctx);
    const settled = await harness.waitForTask(id, ctx);
    assert.equal(settled.state.outcome.status, "failed");
    if (settled.state.outcome.status === "failed") {
      assert.match(settled.state.outcome.error.message, /revision mismatch/);
    }
  } finally { await harness.close(ctx).catch(() => {}); }
}));

test("SIGKILL after external effect, before receipt => manual reconciliation and no replayed effect", async () => inTemp(async dir => {
  const db = join(dir, "session.sqlite");
  const runIdFile = join(dir, "run-id.txt");
  const sideEffects = join(dir, "approvals.log");
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    new URL("./durable-kill-worker.ts", import.meta.url).pathname,
    db, runIdFile, sideEffects,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    new Promise<never>((_, reject) => setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker timeout: " + stderr));
    }, 12_000)),
  ]);
  assert.equal(exit.signal, "SIGKILL", "worker did not die during effect: " + stderr);
  const id = Number(await readFile(runIdFile, "utf8")) as TaskId<WorkflowOutcome>;
  assert.ok(Number.isSafeInteger(id));
  const before = (await readFile(sideEffects, "utf8")).trim().split("\n");
  assert.equal(before.length, 1, "the external effect was attempted exactly once");

  let postRestartCalls = 0;
  const { registry } = await trustedFixture({
    approve: async () => { postRestartCalls++; throw new Error("effect MUST NOT replay"); },
  });
  const harness = await Harness.open(await openNodeSqliteStorage(db),
    { models: createModels(), registry }, ctx);
  try {
    const settled = await harness.waitForTask(id, ctx);
    assert.equal(settled.state.outcome.status, "completed");
    if (settled.state.outcome.status === "completed") {
      const value = settled.state.outcome.result;
      assert.equal(value.status, "needs_reconciliation");
      if (value.status === "needs_reconciliation") {
        assert.equal(value.steps.length, 2);
        assert.ok(value.effectKey.includes("approval"));
        assert.equal(value.effectKey, before[0]);
      }
    }
    assert.equal(postRestartCalls, 0);
    assert.equal((await readFile(sideEffects, "utf8")).trim().split("\n").length, 1);
    console.log("PASS: SIGKILL replay returned needs_reconciliation; external effect not repeated");
  } finally { await harness.close(ctx).catch(() => {}); }
}));
