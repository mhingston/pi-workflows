/**
 * Invoked as a separate OS process by tests/durable.test.ts.
 * It intentionally SIGKILLs itself AFTER the fake external effect has
 * completed but BEFORE its durable receipt is committed.
 */
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { trustedFixture } from "./support/trusted-fixture.ts";

const [dbPath, runIdPath, effectFile] = process.argv.slice(2);
assert.ok(dbPath && runIdPath && effectFile, "worker needs db, task ID, effect file");
const { Run, registry, input } = await trustedFixture({
  approve: async key => {
    // This append simulates a non-transactional external API call.
    // It is deliberately outside of the SQLite checkpoint transaction.
    await appendFile(effectFile, key + "\n");
    process.kill(process.pid, "SIGKILL");
    throw new Error("unreachable after SIGKILL");
  },
});
const ctx = BACKGROUND_CONTEXT;
const harness = await Harness.open(
  await openNodeSqliteStorage(dbPath),
  { models: createModels(), registry }, ctx,
);
const root = await harness.root(ctx);
const id = await root.commit(
  tx => tx.createTask(Run, input([2, 3], true), { ownership: { kind: "conversation" } }),
  ctx,
);
// Only resume after task ID is durable and communicated to the parent.
await writeFile(runIdPath, String(id));
harness.resume();
await harness.waitForTask(id, ctx);
// Should never reach this line; the approval callback kills the process.
throw new Error("worker unexpectedly finished without SIGKILL");
