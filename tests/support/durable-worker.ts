/**
 * Real Node subprocess for restart and SIGKILL fault injection.
 * Driver tests invoke this file with fresh processes and one shared SQLite DB.
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ExampleResult } from "../../fixtures/durable/workflow.ts";
import { startTrustedWorkflow } from "../../src/runtime/pi-durable.ts";
import { FileEffectPort } from "./external-effect.ts";
import { setupWorkflow } from "./workflow-setup.ts";

const [mode, directory] = process.argv.slice(2);
if (!mode || !directory) throw new Error("usage: durable-worker.ts <mode> <directory>");
await mkdir(directory, { recursive: true });

const effects = new FileEffectPort(directory, mode === "crash"
  ? async result => {
      if (result === "applied") {
        // Parent test waits for stdout, then sends SIGKILL. No graceful close.
        process.stdout.write("EFFECT_APPLIED\n");
        await new Promise<void>(() => {});
      }
    }
  : undefined);
const { artifact, registered, registry } = await setupWorkflow(effects);
const context = BACKGROUND_CONTEXT;
const db = join(directory, "session.sqlite");
const harness = await Harness.open(
  await openNodeSqliteStorage(db), { models: createModels(), registry }, context,
);

try {
  let taskId: TaskId<ExampleResult>;
  if (mode === "resume") {
    const meta = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as {
      taskId: number; runId: string; sourceSha256: string;
    };
    assert.equal(meta.sourceSha256, artifact.manifest.sourceSha256, "workflow revision changed");
    taskId = meta.taskId as TaskId<ExampleResult>;
  } else {
    const values = mode === "skip" ? [-1, 0, -5] : [2, -3, 3];
    const runId = mode === "uncertain" ? "test-uncertain" : "test-run";
    if (mode === "uncertain") {
      // Same idempotency key as the coming effect, but different amount.
      // Reconciliation is required instead of pretending the retry succeeded.
      const poisoned = await effects.apply("native_example:test-uncertain:record-result", 999);
      assert.equal(poisoned, "applied");
    }
    const started = await startTrustedWorkflow(
      harness, artifact, registered, { values }, context, runId,
    );
    taskId = started.taskId;
    await writeFile(join(directory, "run.json"), JSON.stringify({
      taskId, runId: started.runId, sourceSha256: started.revision.sourceSha256,
    }), "utf8");
  }

  harness.resume();
  const final = await harness.waitForTask(taskId, context);
  const result = final.state.outcome;
  const record = await harness.getTask(taskId, context);
  assert.equal(record?.state.status, "terminal");
  await writeFile(join(directory, "result.json"), JSON.stringify({
    taskId, outcome: result,
    recordedInput: record?.input, state: record?.state.status,
  }, null, 2));
  console.log("RESULT_WRITTEN");
} finally {
  await harness.close(context);
}
