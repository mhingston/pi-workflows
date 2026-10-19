import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { trustedFixture } from "./support/trusted-fixture.ts";
import { idempotentFileProvider, receiptPath } from "./support/idempotent-effect.ts";
import type { ApprovalRequest, WorkflowOutcome } from "../src/durable/fixture-runtime.ts";

const ctx = BACKGROUND_CONTEXT;

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-idempotency-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

type Attempt = { idempotencyKey: string; request: ApprovalRequest };
async function attempts(providerDir: string): Promise<Attempt[]> {
  return (await readFile(join(providerDir, "attempts.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line) as Attempt);
}

async function killBetweenProviderAndCheckpoint(
  db: string, runIdFile: string, providerDir: string, childRunsFile: string,
): Promise<void> {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    new URL("./durable-idempotency-worker.ts", import.meta.url).pathname,
    db, runIdFile, providerDir, childRunsFile,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker timed out: " + stderr));
    }, 12_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.equal(exit.signal, "SIGKILL", "worker did not stop after external apply: " + stderr);
}

test("provider contract: same operation is deduplicated, changed payload conflicts", async () =>
  inTemp(async dir => {
    const provider = idempotentFileProvider(dir);
    const key = "operation:approval";
    const first: ApprovalRequest = { reason: "approve", inputSha256: "a".repeat(64) };
    const different: ApprovalRequest = { ...first, inputSha256: "b".repeat(64) };
    assert.equal((await provider.applyIdempotently(key, first)).status, "applied");
    assert.equal((await provider.applyIdempotently(key, first)).status, "already_applied");
    assert.equal((await provider.applyIdempotently(key, different)).status, "conflict");
    const receipt = JSON.parse(await readFile(receiptPath(dir, key), "utf8"));
    assert.deepEqual(receipt.request, first, "duplicate requests did not overwrite the first application");
    assert.equal((await attempts(dir)).length, 3);
  }));

test("normal native run records provider-applied result and child receipts", async () =>
  inTemp(async dir => {
    const providerDir = join(dir, "provider");
    const { Run, registry, input } = await trustedFixture(idempotentFileProvider(providerDir));
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "native.sqlite")),
      { models: createModels(), registry }, ctx);
    try {
      const root = await harness.root(ctx);
      const id = await root.commit(
        tx => tx.createTask(Run, input([2, 3], true), { ownership: { kind: "conversation" } }), ctx);
      const task = await harness.waitForTask(id, ctx);
      assert.equal(task.state.outcome.status, "completed");
      if (task.state.outcome.status === "completed") {
        const result = task.state.outcome.result;
        assert.equal(result.status, "completed");
        if (result.status === "completed") {
          assert.equal(result.output, 10);
          assert.equal(result.approvalDisposition, "applied");
          assert.equal(result.steps.length, 2);
        }
      }
      assert.equal((await attempts(providerDir)).length, 1);
    } finally { await harness.close(ctx).catch(() => {}); }
  }));

for (const scenario of ["matching", "conflict", "unknown"] as const) {
  test(`SIGKILL replay: ${scenario} provider receipt is handled without duplicate application or children`,
    async () => inTemp(async dir => {
      const db = join(dir, "session.sqlite");
      const runIdFile = join(dir, "run-id.txt");
      const providerDir = join(dir, "external-provider");
      const childRunsFile = join(dir, "child-runs.log");
      await killBetweenProviderAndCheckpoint(db, runIdFile, providerDir, childRunsFile);
      const id = Number(await readFile(runIdFile, "utf8")) as TaskId<WorkflowOutcome>;
      assert.ok(Number.isSafeInteger(Number(id)));
      const before = await attempts(providerDir);
      assert.equal(before.length, 1, "provider should have applied once before crash");
      const { idempotencyKey, request } = before[0]!;
      const receiptFile = receiptPath(providerDir, idempotencyKey);
      const applied = JSON.parse(await readFile(receiptFile, "utf8"));
      assert.deepEqual(applied, { idempotencyKey, request, approved: true });
      const childrenBefore = (await readFile(childRunsFile, "utf8")).trim().split("\n").map(Number);
      assert.equal(childrenBefore.length, 2, "native children must finish before approval");
      assert.equal(new Set(childrenBefore).size, 2);

      if (scenario === "conflict") {
        await writeFile(receiptFile, JSON.stringify({
          idempotencyKey,
          request: { ...request, reason: "different approval operation" },
          approved: true,
        }));
      } else if (scenario === "unknown") {
        await writeFile(receiptFile, "{truncated receipt");
      }
      const { registry } = await trustedFixture(idempotentFileProvider(providerDir), {
        childExecuted: async childId => { throw new Error("checkpointed child reran: " + childId); },
      });
      const harness = await Harness.open(await openNodeSqliteStorage(db),
        { models: createModels(), registry }, ctx);
      try {
        const task = await harness.waitForTask(id, ctx);
        assert.equal(task.state.outcome.status, "completed");
        if (task.state.outcome.status === "completed") {
          const result = task.state.outcome.result;
          if (scenario === "matching") {
            assert.equal(result.status, "completed", "matching provider receipt permits safe completion");
            if (result.status === "completed") {
              assert.equal(result.output, 10);
              assert.equal(result.approvalDisposition, "already_applied");
              assert.deepEqual(result.steps.map(step => step.taskId), childrenBefore);
              for (const step of result.steps) {
                const child = await harness.getTask(step.taskId as TaskId<number>, ctx);
                assert.equal(child?.state.status, "terminal");
                if (child?.state.status === "terminal") {
                  assert.equal(child.state.outcome.status, "completed");
                }
              }
            }
          } else {
            assert.equal(result.status, "needs_reconciliation", "uncertain/conflicting status must fail closed");
            if (result.status === "needs_reconciliation") {
              assert.equal(result.effectKey, idempotencyKey);
              assert.deepEqual(result.steps.map(step => step.taskId), childrenBefore);
            }
          }
        }
        assert.deepEqual(
          (await readFile(childRunsFile, "utf8")).trim().split("\n").map(Number),
          childrenBefore, "checkpointed child work must not replay",
        );
        const after = await attempts(providerDir);
        assert.equal(after.length, 2, "one replay attempt after real SIGKILL");
        assert.deepEqual(after, [before[0], before[0]], "replay must use the same key AND payload");
        // The external provider's exclusive-create ledger performed only the
        // original application. Repeated calls returned matching/unsafe status.
      } finally { await harness.close(ctx).catch(() => {}); }
    }));
}
