/**
 * Real OS-level interruption at either side of Pi Durable's approval
 * receipt commit, before the terminal parent outcome.
 */
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { trustedFixture } from "./support/trusted-fixture.ts";
import { idempotentFileProvider } from "./support/idempotent-effect.ts";

const [db, runIdFile, providerDir, childRunsFile, boundary] = process.argv.slice(2);
assert.ok(db && runIdFile && providerDir && childRunsFile, "missing worker arguments");
assert.ok(boundary === "before-receipt" || boundary === "after-receipt", "invalid kill boundary");
const provider = idempotentFileProvider(providerDir);
const { Run, registry, input } = await trustedFixture({
  applyIdempotently: async (key, request) => {
    const response = await provider.applyIdempotently(key, request);
    if (response.status !== "applied") throw new Error("first invocation was not applied");
    // Kill at the first boundary, before Pi Durable's receipt memo.
    if (boundary === "before-receipt") {
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable");
    }
    return response;
  },
}, {
  childExecuted: async taskId => { await appendFile(childRunsFile, taskId + "\n"); },
  afterApprovalReceipt: async () => {
    // This runs after runtime.memo("approval-receipt") has committed.
    if (boundary === "after-receipt") {
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable");
    }
  },
});
const ctx = BACKGROUND_CONTEXT;
const harness = await Harness.open(
  await openNodeSqliteStorage(db), { models: createModels(), registry }, ctx,
);
const root = await harness.root(ctx);
const id = await root.commit(
  tx => tx.createTask(Run, input([2, 3], true), { ownership: { kind: "conversation" } }), ctx,
);
await writeFile(runIdFile, String(id));
harness.resume();
await harness.waitForTask(id, ctx);
throw new Error("worker should have been SIGKILLed");
