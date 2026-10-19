/**
 * Trusted native task implementation used by issue #3.
 * The file's exact source text is the canonical workflow.ts artifact.
 * It is registered/bundled ahead of time: nothing evaluates imported artifacts.
 */
import { defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { PinnedRunInput, WorkflowRevision } from "../../src/runtime/pi-durable.ts";

export type ExampleInput = { values: number[] };

export type EffectReceipt = {
  idempotencyKey: string;
  disposition: "applied" | "already_applied";
};

export type EffectAttempt = "applied" | "already_applied" | "uncertain";

export interface EffectPort {
  apply(idempotencyKey: string, amount: number): Promise<EffectAttempt>;
  /** Test-only seam: crash after the external effect, before Pi checkpoint. */
  afterApply?(result: EffectAttempt): Promise<void>;
}

export type ExampleResult = {
  runId: string;
  revision: WorkflowRevision;
  branch: "processed" | "skipped";
  inputValues: number[];
  childResults: number[];
  total: number;
  effect: EffectReceipt | null;
};

type ChildState = { phase: "calculate" };
type ParentState =
  | { phase: "select" }
  | { phase: "collect"; children: TaskId<number>[]; selected: number[] }
  | { phase: "effect"; selected: number[]; childResults: number[]; total: number };

export function registerExampleWorkflow(effects: EffectPort, expected: WorkflowRevision) {
  const child = defineTask<{ value: number }, ChildState, number>({
    name: "pi-workflows.example.child",
    version: 1,
    initial: () => ({ phase: "calculate" }),
    phases: {
      calculate: async (task, runtime, ctx) => {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: task.input.value * 2 } }),
          ctx,
        );
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

  const parent = defineTask<PinnedRunInput<ExampleInput>, ParentState, ExampleResult>({
    name: "pi-workflows.example.parent",
    version: 1,
    initial: () => ({ phase: "select" }),
    phases: {
      select: async (task, runtime, ctx) => {
        const { revision, input } = task.input;
        // Refuse to resume an existing run on changed source/dependencies.
        if (JSON.stringify(revision) !== JSON.stringify(expected)) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "failed", error: { message: "pinned workflow revision mismatch" } },
          }), ctx);
          return;
        }
        const selected = input.values.filter(value => value > 0);
        if (selected.length === 0) {
          const result: ExampleResult = {
            runId: task.input.runId, revision, branch: "skipped",
            inputValues: [...input.values], childResults: [], total: 0, effect: null,
          };
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "completed", result },
          }), ctx);
          return;
        }
        // Task creation and parent waiting checkpoint are one Pi Durable transaction.
        await runtime.commit(async tx => {
          const children: TaskId<number>[] = [];
          for (const value of selected) {
            children.push(await tx.createTask(child, { value }, {
              ownership: { kind: "task", taskId: task.id },
            }));
          }
          return {
            status: "waiting",
            checkpoint: { phase: "collect", children, selected },
            on: children,
            policy: "allSettled",
          };
        }, ctx);
      },
      collect: async (task, runtime, ctx) => {
        if (JSON.stringify(task.input.revision) !== JSON.stringify(expected)) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "failed", error: { message: "pinned workflow revision mismatch" } },
          }), ctx);
          return;
        }
        const results = await runtime.outcomes(task.state.checkpoint.children, ctx);
        if (results.some(outcome => outcome.status !== "completed")) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "failed", error: { message: "child task did not complete" } },
          }), ctx);
          return;
        }
        const childResults = results.map(outcome => outcome.status === "completed" ? outcome.result : 0);
        const total = childResults.reduce((a, b) => a + b, 0);
        await runtime.commit(() => ({
          status: "running",
          checkpoint: {
            phase: "effect", selected: task.state.checkpoint.selected,
            childResults, total,
          },
        }), ctx);
      },
      effect: async (task, runtime, ctx) => {
        if (JSON.stringify(task.input.revision) !== JSON.stringify(expected)) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "failed", error: { message: "pinned workflow revision mismatch" } },
          }), ctx);
          return;
        }
        const state = task.state.checkpoint;
        const idempotencyKey = expected.id + ":" + task.input.runId + ":record-result";
        const disposition = await effects.apply(idempotencyKey, state.total);
        if (disposition === "uncertain") {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: {
              status: "failed",
              error: { message: "external effect outcome uncertain; manual reconciliation required" },
            },
          }), ctx);
          return;
        }
        // Inject a SIGKILL in the test after the external effect succeeds,
        // before a Pi Durable terminal checkpoint is committed.
        await effects.afterApply?.(disposition);
        const result: ExampleResult = {
          runId: task.input.runId,
          revision: task.input.revision,
          branch: "processed",
          inputValues: [...task.input.input.values],
          childResults: state.childResults,
          total: state.total,
          effect: { idempotencyKey, disposition },
        };
        await runtime.commit(() => ({
          status: "terminal", outcome: { status: "completed", result },
        }), ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

  return { child, parent };
}
