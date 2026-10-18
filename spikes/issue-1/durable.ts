/**
 * Issue #1: execute/reopen a native Pi Durable parent -> children task tree.
 *
 * Run: npm run smoke:durable
 * No model provider credentials needed. Uses real SQLite storage, not an
 * in-memory implementation. Demonstrates checkpointed sleep + child join
 * across a controlled Harness.close()/reopen(), NOT a process-kill guarantee.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;

// Published Pi Durable 1.3.0 exposes invocation-bound sleep(), not
// the persisted phase-boundary sleepUntil() added later on upstream main.
// After close/reopen, this child's phase is eligible to rerun from the top.
type ChildState = { phase: "run" };
const Child = defineTask<number, ChildState, number>({
  name: "spike.child",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, ctx) => {
      await runtime.sleep(runtime.now() + 300, ctx);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: task.input } }),
        ctx,
      );
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});

type ParentState = { phase: "spawn" } | { phase: "collect"; children: TaskId<number>[] };
const Parent = defineTask<{ values: number[] }, ParentState, number>({
  name: "spike.parent",
  version: 1,
  initial: () => ({ phase: "spawn" }),
  phases: {
    spawn: async (task, runtime, ctx) => {
      // The children and the parent's waiting checkpoint are ONE atomic commit.
      await runtime.commit(async (tx) => {
        const children: TaskId<number>[] = [];
        for (const value of task.input.values) {
          children.push(
            await tx.createTask(Child, value, { ownership: { kind: "task", taskId: task.id } }),
          );
        }
        return {
          status: "waiting",
          checkpoint: { phase: "collect", children },
          on: children,
          policy: "failFast",
        };
      }, ctx);
    },
    collect: async (task, runtime, ctx) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.children, ctx);
      if (outcomes.some((outcome) => outcome.status !== "completed")) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "failed", error: { message: "Child failed" } } }),
          ctx,
        );
        return;
      }
      const sum = outcomes.reduce(
        (total, outcome) => total + (outcome.status === "completed" ? outcome.result : 0),
        0,
      );
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: sum } }),
        ctx,
      );
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "spike.tasks", tasks: [Child, Parent] }));
const directory = await mkdtemp(join(tmpdir(), "pi-workflows-feasibility-"));
const databasePath = join(directory, "session.sqlite");
const open = async () => Harness.open(
  await openNodeSqliteStorage(databasePath),
  { models: createModels(), registry },
  context,
);

let harness = await open();

try {
  const root = await harness.root(context);
  const parentId = await root.commit(
    (tx) => tx.createTask(Parent, { values: [2, 3] }, { ownership: { kind: "conversation" } }),
    context,
  );

  harness.resume();
  // Await the *committed* waiting checkpoint rather than guessing a timer delay.
  let waiting = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await harness.getTask(parentId, context);
    if (record?.state.status === "waiting") {
      waiting = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(waiting, true, "Parent did not reach a committed child-join checkpoint");

  await harness.close(context);
  harness = await open();
  const settled = await harness.waitForTask(parentId, context);
  assert.equal(settled.state.outcome.status, "completed");
  if (settled.state.outcome.status === "completed") {
    assert.equal(settled.state.outcome.result, 5);
  }
  console.log("PASS: durable child tasks resumed and parent returned 5 after reopen");
} finally {
  await harness.close(context).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
