/**
 * Issue #3: an intentionally narrow Pi Durable adapter for the trusted
 * fixtures/complex/workflow.ts module, NOT a general TS replay engine.
 *
 * Native Pi Durable owns the parent/child task tree, atomic dispatch and
 * checkpoint receipts. The checked-in canonical workflow is called in the
 * collect phase with ports backed by durable child outcomes.
 */
import { createRegistry, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { LoadedWorkflow } from "../artifact.ts";
import { runWorkflow, type WorkflowInput } from "../../fixtures/complex/workflow.ts";

export const FIXTURE_CAPABILITIES = ["agent", "hooks", "approval", "dynamic_tasks"] as const;

export type StepReceipt = { taskId: number; input: number; result: number };
export type WorkflowOutcome =
  | { status: "completed"; output: number; steps: StepReceipt[]; sourceSha256: string; workflowVersion: string }
  | { status: "needs_reconciliation"; effectKey: string; steps: StepReceipt[]; sourceSha256: string; workflowVersion: string };

export interface ApprovalEffect {
  /**
   * Effect may happen before receipt persistence. This MUST NOT blindly retry.
   * The stable key permits an external provider to deduplicate/reconcile.
   */
  approve(idempotencyKey: string): Promise<boolean>;
}

export type RunInput = {
  workflowId: string;
  workflowVersion: string;
  sourceSha256: string;
  input: WorkflowInput;
};

export type RunState =
  | { phase: "dispatch" }
  | { phase: "collect"; childIds: TaskId<number>[]; values: number[] };

class UncertainEffect extends Error {
  constructor(readonly effectKey: string) { super("effect outcome uncertain; manual reconciliation required"); }
}

/**
 * The only supported task family is a trusted, explicitly registered module.
 * The adapter refuses unknown source revisions, capabilities or entrypoints.
 *
 * On reopen the host must re-load the source artifact and register this same
 * task name/version. A persisted run's source fingerprint is checked again in
 * the collect phase, so a changed file cannot quietly resume old tasks.
 */
export function registerFixtureWorkflow(artifact: LoadedWorkflow, effect: ApprovalEffect) {
  const manifest = artifact.manifest;
  if (manifest.id !== "dynamic_agents" || manifest.entrypoint !== "workflow.ts") {
    throw new Error("unsupported workflow: only trusted dynamic_agents is registered");
  }
  if (manifest.requiredCapabilities.some(cap => !FIXTURE_CAPABILITIES.includes(
    cap as (typeof FIXTURE_CAPABILITIES)[number],
  ))) throw new Error("unsupported workflow capability");
  // The caller is responsible for loading/verifying the canonical source
  // with loadWorkflow() before registering the module.
  const Child = defineTask<number, { phase: "work"; deadline: number }, number>({
    name: "pi-workflows.fixture.child",
    version: 1,
    initial: () => ({ phase: "work", deadline: Date.now() + 150 }),
    phases: {
      work: async (task, runtime, ctx) => {
        // Wait deliberately so tests can stop the harness mid-execution.
        await runtime.sleep(task.state.checkpoint.deadline, ctx);
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

  const Run = defineTask<RunInput, RunState, WorkflowOutcome>({
    name: "pi-workflows.fixture.run",
    version: 1,
    initial: () => ({ phase: "dispatch" }),
    phases: {
      dispatch: async (task, runtime, ctx) => {
        if (task.input.workflowId !== manifest.id ||
            task.input.workflowVersion !== manifest.version ||
            task.input.sourceSha256 !== manifest.sourceSha256) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "failed", error: { message: "workflow revision mismatch" } },
          }), ctx);
          return;
        }
        const values = task.input.input.values.filter(value => value > 0);
        await runtime.commit(async tx => {
          const childIds: TaskId<number>[] = [];
          for (const value of values) {
            childIds.push(await tx.createTask(Child, value, {
              ownership: { kind: "task", taskId: task.id },
            }));
          }
          if (childIds.length === 0) {
            return { status: "running", checkpoint: { phase: "collect", childIds, values } };
          }
          // Atomic: committed children + parent join checkpoint.
          return { status: "waiting", checkpoint: { phase: "collect", childIds, values },
            on: childIds, policy: "allSettled" };
        }, ctx);
      },
      collect: async (task, runtime, ctx) => {
        if (task.input.sourceSha256 !== manifest.sourceSha256 ||
            task.input.workflowVersion !== manifest.version) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "failed", error: { message: "workflow revision changed while running" } },
          }), ctx);
          return;
        }
        const ids = task.state.checkpoint.childIds;
        const outcomes = await runtime.outcomes(ids, ctx);
        if (!outcomes.every(outcome => outcome.status === "completed")) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "failed", error: { message: "child task did not complete" } },
          }), ctx);
          return;
        }

        const values = task.state.checkpoint.values;
        const steps: StepReceipt[] = ids.map((taskId, i) => ({
          taskId, input: values[i]!, result: outcomes[i]!.status === "completed" ? outcomes[i]!.result : NaN,
        }));
        let cursor = 0;
        const effectKey = [task.input.sourceSha256, String(task.id), "approval"].join(":");
        try {
          // Run the canonical TypeScript fixture, resolving agent calls with
          // existing durable child receipts rather than spawning ephemeral work.
          const output = await runWorkflow(task.input.input, {
            agent: async (name, value) => {
              if (name !== "worker" || cursor >= steps.length || steps[cursor]?.input !== value) {
                throw new Error("native child dispatch diverged from canonical workflow");
              }
              return steps[cursor++]!.result;
            },
            // The sample hooks are pure telemetry/no-op. Arbitrary effectful
            // hooks require a real effect policy in a future adapter.
            hook: async () => {},
            approve: async () => {
              const receipt = await runtime.memo<boolean>("approval-receipt", ctx);
              if (receipt !== undefined) return receipt;
              const intent = await runtime.memo<string>("approval-intent", ctx);
              if (intent !== undefined) throw new UncertainEffect(effectKey);
              // Commit the intent before invoking the effect. A crash after this
              // point but before the receipt leaves an UNCERTAIN result, and we
              // deliberately DO NOT re-execute the effect on replay.
              await runtime.memo("approval-intent", effectKey, ctx);
              const approved = await effect.approve(effectKey);
              await runtime.memo("approval-receipt", approved, ctx);
              return approved;
            },
          });
          if (cursor !== steps.length) throw new Error("not all child results were consumed");
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "completed", result: {
              status: "completed", output, steps,
              workflowVersion: task.input.workflowVersion, sourceSha256: task.input.sourceSha256,
            } },
          }), ctx);
        } catch (err) {
          if (err instanceof UncertainEffect) {
            await runtime.commit(() => ({
              status: "terminal", outcome: { status: "completed", result: {
                status: "needs_reconciliation", effectKey, steps,
                workflowVersion: task.input.workflowVersion, sourceSha256: task.input.sourceSha256,
              } },
            }), ctx);
          } else {
            // No unverified effects retried by our own scheduler. A failed
            // canonical execution is a failed native Pi Durable task.
            await runtime.commit(() => ({
              status: "terminal", outcome: { status: "failed", error: {
                message: err instanceof Error ? err.message : "workflow failed",
              } },
            }), ctx);
          }
        }
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "pi-workflows.fixture", tasks: [Child, Run] }));
  function input(values: number[], requiresApproval: boolean): RunInput {
    if (!Array.isArray(values) || !values.every(Number.isFinite) || typeof requiresApproval !== "boolean") {
      throw new Error("invalid fixture workflow input");
    }
    return {
      workflowId: manifest.id,
      workflowVersion: manifest.version,
      sourceSha256: manifest.sourceSha256,
      input: { values, requiresApproval },
    };
  }
  return { Run, registry, input };
}
