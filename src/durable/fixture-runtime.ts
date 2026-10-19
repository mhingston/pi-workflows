/**
 * Issue #3: an intentionally narrow Pi Durable adapter for the trusted
 * fixtures/complex/workflow.ts module, NOT a general TS replay engine.
 *
 * Native Pi Durable owns the parent/child task tree, atomic dispatch and
 * checkpoint receipts. The checked-in canonical workflow is called in the
 * collect phase with ports backed by durable child outcomes.
 */
import { createRegistry, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import { sha256, type LoadedWorkflow } from "../artifact.ts";
import { isDeepStrictEqual } from "node:util";
import type { ProviderDescriptor } from "../providers.ts";
import { runWorkflow, type WorkflowInput } from "../../fixtures/complex/workflow.ts";

export const FIXTURE_CAPABILITIES = ["agent", "hooks", "approval", "dynamic_tasks"] as const;

export type StepReceipt = { taskId: number; input: number; result: number };
export type WorkflowOutcome =
  | { status: "completed"; output: number; steps: StepReceipt[]; sourceSha256: string; workflowVersion: string;
      /** Provider-confirmed status (absent for the legacy approval port). */
      approvalDisposition?: "applied" | "already_applied" }
  | { status: "needs_reconciliation"; effectKey: string; steps: StepReceipt[]; sourceSha256: string; workflowVersion: string }
  /** Native failed/aborted outcome receipt: child IDs without inventing step successes. */
  | { status: "unsuccessful"; childTaskIds: number[] };

/** The exact application payload is bound to the immutable native run input. */
export type ApprovalRequest = { reason: string; inputSha256: string };

export type ProviderApprovalResult =
  | { status: "applied" | "already_applied"; idempotencyKey: string;
      request: ApprovalRequest; approved: boolean }
  | { status: "unknown" | "conflict" };

/**
 * Only the second port promises provider-side atomic idempotency for an entire
 * key + request, including authoritative receipt lookup on repeated calls.
 * The legacy port has NO replay permission even when its key is stable.
 */
export type ApprovalEffect =
  | { approve(idempotencyKey: string): Promise<boolean>; applyIdempotently?: never }
  | { applyIdempotently(idempotencyKey: string, request: ApprovalRequest): Promise<ProviderApprovalResult>;
      approve?: never };

/** Test-only child execution probe, not a production hook or tracing API. */
export type FixtureProbe = { childExecuted?: (taskId: number) => Promise<void> };

export interface PublishedRunProvenance {
  readonly revisionId: string;
  readonly runtime: ProviderDescriptor;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly configurationSha256: string;
  readonly inputSha256: string;
}

export type RunInput = {
  workflowId: string;
  workflowVersion: string;
  sourceSha256: string;
  /** UI consent is recorded separately from the external effect receipt. */
  interactiveApproval: "approved" | "not_required" | "not_recorded";
  input: WorkflowInput;
  /** Exact immutable revision + executing implementation; absent only in legacy direct tests. */
  publication?: PublishedRunProvenance;
};

export type RunState =
  | { phase: "dispatch" }
  | { phase: "collect"; childIds: TaskId<number>[]; values: number[] };

class UncertainEffect extends Error {
  readonly effectKey: string;
  constructor(effectKey: string) {
    super("effect outcome uncertain; manual reconciliation required");
    this.effectKey = effectKey;
  }
}

/**
 * The only supported task family is a trusted, explicitly registered module.
 * The adapter refuses unknown source revisions, capabilities or entrypoints.
 *
 * On reopen the host must re-load the source artifact and register this same
 * task name/version. A persisted run's source fingerprint is checked again in
 * the collect phase, so a changed file cannot quietly resume old tasks.
 */
export function registerFixtureWorkflow(
  artifact: LoadedWorkflow,
  effect: ApprovalEffect,
  published?: Omit<PublishedRunProvenance, "inputSha256">,
  probe?: FixtureProbe,
) {
  async function matchingPublication(input: RunInput): Promise<boolean> {
    if (!published) return input.publication === undefined;
    if (!input.publication) return false;
    const { inputSha256, ...recorded } = input.publication;
    return isDeepStrictEqual(recorded, published) &&
      inputSha256 === await sha256(JSON.stringify(input.input));
  }
  const manifest = artifact.manifest;
  if (manifest.id !== "dynamic_agents" || manifest.entrypoint !== "workflow.ts") {
    throw new Error("unsupported workflow: only trusted dynamic_agents is registered");
  }
  if (manifest.requiredCapabilities.some(cap => !FIXTURE_CAPABILITIES.includes(
    cap as (typeof FIXTURE_CAPABILITIES)[number],
  ))) throw new Error("unsupported workflow capability");
  // The caller is responsible for loading/verifying the canonical source
  // with loadWorkflow() before registering the module.
  // Native terminal checkpoints are removed. Preserve direct child IDs on
  // *all* unsuccessful paths so failure/abort inspection remains possible.
  const unsuccessful = (checkpoint: RunState): Extract<WorkflowOutcome, { status: "unsuccessful" }> => ({
    status: "unsuccessful",
    childTaskIds: checkpoint.phase === "collect" ? checkpoint.childIds.map(Number) : [],
  });
  const Child = defineTask<number, { phase: "work"; deadline: number }, number>({
    name: "pi-workflows.fixture.child",
    version: 1,
    initial: () => ({ phase: "work", deadline: Date.now() + 150 }),
    phases: {
      work: async (task, runtime, ctx) => {
        // Test-only proof that terminal children are not re-executed on parent replay.
        await probe?.childExecuted?.(Number(task.id));
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
            task.input.sourceSha256 !== manifest.sourceSha256 ||
            !await matchingPublication(task.input)) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "failed", error: { message: "workflow revision mismatch" },
              result: unsuccessful(task.state.checkpoint) },
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
            task.input.workflowVersion !== manifest.version ||
            !await matchingPublication(task.input)) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "failed", error: { message: "workflow revision changed while running" },
              result: unsuccessful(task.state.checkpoint) },
          }), ctx);
          return;
        }
        const ids = task.state.checkpoint.childIds;
        const outcomes = await runtime.outcomes(ids, ctx);
        if (!outcomes.every(outcome => outcome.status === "completed")) {
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "failed", error: { message: "child task did not complete" },
              result: unsuccessful(task.state.checkpoint) },
          }), ctx);
          return;
        }

        const values = task.state.checkpoint.values;
        const steps: StepReceipt[] = ids.map((taskId, i) => ({
          taskId, input: values[i]!, result: outcomes[i]!.status === "completed" ? outcomes[i]!.result : NaN,
        }));
        let cursor = 0;
        const effectKey = [task.input.sourceSha256, String(task.id), "approval"].join(":");
        let approvalDisposition: "applied" | "already_applied" | undefined;
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
            approve: async reason => {
              const receipt = await runtime.memo<boolean>("approval-receipt", ctx);
              if (receipt !== undefined) return receipt;
              const intent = await runtime.memo<string>("approval-intent", ctx);
              if (intent !== undefined && intent !== effectKey) throw new UncertainEffect(effectKey);
              const idempotent = "applyIdempotently" in effect && !!effect.applyIdempotently;
              // Only a provider contract guaranteeing atomic deduplication permits
              // a repeated request after an intent without a local receipt.
              if (intent !== undefined && !idempotent) throw new UncertainEffect(effectKey);
              if (intent === undefined) await runtime.memo("approval-intent", effectKey, ctx);
              try {
                let approved: boolean;
                if (idempotent) {
                  const request: ApprovalRequest = {
                    reason,
                    inputSha256: await sha256(JSON.stringify(task.input.input)),
                  };
                  const response = await effect.applyIdempotently(effectKey, request);
                  // Never accept a status without an exact, authoritative receipt
                  // for the requested operation. Unknown/conflicting/malformed
                  // provider responses remain ambiguous.
                  if ((response.status !== "applied" && response.status !== "already_applied") ||
                      response.idempotencyKey !== effectKey ||
                      !isDeepStrictEqual(response.request, request) ||
                      typeof response.approved !== "boolean") {
                    throw new UncertainEffect(effectKey);
                  }
                  approvalDisposition = response.status;
                  approved = response.approved;
                } else {
                  approved = await effect.approve(effectKey);
                }
                await runtime.memo("approval-receipt", approved, ctx);
                return approved;
              } catch {
                // A timeout or failed receipt write cannot prove that the
                // provider did not apply the effect. Never guess success.
                throw new UncertainEffect(effectKey);
              }
            },
          });
          if (cursor !== steps.length) throw new Error("not all child results were consumed");
          await runtime.commit(() => ({
            status: "terminal", outcome: { status: "completed", result: {
              status: "completed", output, steps,
              workflowVersion: task.input.workflowVersion, sourceSha256: task.input.sourceSha256,
              ...(approvalDisposition === undefined ? {} : { approvalDisposition }),
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
              }, result: unsuccessful(task.state.checkpoint) },
            }), ctx);
          }
        }
      },
    },
    abort: async (task, runtime, ctx) => {
      await runtime.commit(() => ({
        status: "terminal", outcome: { status: "aborted", result: unsuccessful(task.state.checkpoint) },
      }), ctx);
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "pi-workflows.fixture", tasks: [Child, Run] }));
  function input(
    values: number[], requiresApproval: boolean, interactiveApproval?: "approved",
    publication?: PublishedRunProvenance,
  ): RunInput {
    if (!Array.isArray(values) || !values.every(Number.isFinite) || typeof requiresApproval !== "boolean") {
      throw new Error("invalid fixture workflow input");
    }
    if (!requiresApproval && interactiveApproval === "approved") {
      throw new Error("cannot record consent for a workflow not requiring approval");
    }
    if (published && !publication) throw new Error("published run requires immutable provenance");
    return {
      ...(publication ? { publication } : {}),
      workflowId: manifest.id,
      workflowVersion: manifest.version,
      sourceSha256: manifest.sourceSha256,
      interactiveApproval: requiresApproval ? (interactiveApproval ?? "not_recorded") : "not_required",
      input: { values, requiresApproval },
    };
  }
  return { Run, registry, input };
}
