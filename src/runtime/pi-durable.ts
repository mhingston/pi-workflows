/**
 * Minimal native Pi Durable adapter for pre-registered, trusted workflow tasks.
 * No workflow scheduler, source eval, or companion persistence store.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness, Task, TaskId } from "@earendil-works/pi-durable";
import type { LoadedWorkflow } from "../artifact.ts";

export type WorkflowRevision = {
  id: string;
  version: string;
  sourceSha256: string;
  dependencies: Record<string, string>;
};

/** Persisted as the Pi Durable task's input, rather than a process-local closure. */
export type PinnedRunInput<I> = {
  runId: string;
  revision: WorkflowRevision;
  input: I;
};

export type TrustedWorkflow<I, S extends { phase: string }, R> = {
  /** Must refer to an installed native task implementation. */
  task: Task<PinnedRunInput<I>, S, R, object>;
  revision: WorkflowRevision;
  capabilities: readonly string[];
};

export type StartedWorkflow<R> = {
  runId: string;
  taskId: TaskId<R>;
  revision: WorkflowRevision;
};

export function assertRegisteredWorkflow<I, S extends { phase: string }, R>(
  artifact: LoadedWorkflow,
  registered: TrustedWorkflow<I, S, R>,
): void {
  const manifest = artifact.manifest;
  const pinned = registered.revision;
  if (pinned.id !== manifest.id ||
      pinned.version !== manifest.version ||
      pinned.sourceSha256 !== manifest.sourceSha256 ||
      JSON.stringify(Object.entries(pinned.dependencies).sort()) !==
      JSON.stringify(Object.entries(manifest.dependencies).sort())) {
    throw new Error("workflow artifact does not match the trusted installed revision");
  }
  const missing = manifest.requiredCapabilities.filter(
    capability => !registered.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new Error("unsupported workflow capabilities: " + missing.join(", "));
  }
}

/**
 * Start a task pinned to exactly the source/dependencies inspected on import.
 * Revision/inputs are stored in Pi Durable's native task input.
 * Ownership, run status, children, checkpoints and terminal results are native.
 */
export async function startTrustedWorkflow<I, S extends { phase: string }, R>(
  harness: Harness,
  artifact: LoadedWorkflow,
  registered: TrustedWorkflow<I, S, R>,
  input: I,
  context: Context,
  runId: string = crypto.randomUUID(),
): Promise<StartedWorkflow<R>> {
  assertRegisteredWorkflow(artifact, registered);
  if (!runId || runId.length > 128) throw new Error("invalid workflow run ID");
  const revision = {
    ...registered.revision,
    dependencies: { ...registered.revision.dependencies },
  };
  const root = await harness.root(context);
  const taskId = await root.commit(
    tx => tx.createTask(registered.task, { runId, revision, input }, {
      ownership: { kind: "conversation" },
    }),
    context,
  );
  return { runId, taskId, revision };
}
