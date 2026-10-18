/**
 * Pi Durable task ownership/checkpoint API smoke probe.
 *
 * npm install
 * npm run probe:durable
 *
 * No model calls, credentials, or external effects. MemoryStorage deliberately
 * does NOT test recovery: see docs/feasibility.md for the restart experiment.
 * Source contract checked against @earendil-works/pi-durable 1.3.0,
 * earendil-works/pi commit 482c1381a00d8d00bc81697e4a980c593db6803e.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type TaskId,
} from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;

const Child = defineTask<{ value: number }, { phase: "calculate" }, number>({
  name: "spike.child",
  version: 1,
  initial: () => ({ phase: "calculate" }),
  phases: {
    calculate: async (task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: task.input.value * 2 } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ParentState =
  | { phase: "spawn" }
  | { phase: "collect"; children: TaskId<number>[] };

const Parent = defineTask<{ values: number[] }, ParentState, number>({
  name: "spike.parent",
  version: 1,
  initial: () => ({ phase: "spawn" }),
  phases: {
    spawn: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const children: TaskId<number>[] = [];
        for (const value of task.input.values) {
          children.push(
            await tx.createTask(Child, { value }, { ownership: { kind: "task", taskId: task.id } }),
          );
        }
        return { status: "waiting", checkpoint: { phase: "collect", children }, on: children, policy: "allSettled" };
      }, context);
    },
    collect: async (task, runtime, context) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.children, context);
      if (outcomes.some((outcome) => outcome.status !== "completed")) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "failed", error: { message: "child failed" } } }),
          context,
        );
        return;
      }
      const sum = outcomes.reduce((total, outcome) => total + (outcome.status === "completed" ? outcome.result : 0), 0);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: sum } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "spike", tasks: [Child, Parent] }));

const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
try {
  const root = await harness.root(ctx);
  const taskId = await root.commit(
    (tx) => tx.createTask(Parent, { values: [1, 2, 3] }, { ownership: { kind: "conversation" } }),
    ctx,
  );

  const completed = await harness.waitForTask(taskId, ctx);
  if (completed.state.status !== "terminal"
    || completed.state.outcome.status !== "completed"
    || completed.state.outcome.result !== 12) {
    throw new Error(`Unexpected parent outcome: ${JSON.stringify(completed.state)}`);
  }
  console.log("PASS: durable parent + child ownership + waiting + result (12)");
} finally {
  await harness.close(ctx);
}
