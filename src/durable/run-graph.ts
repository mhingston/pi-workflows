/**
 * Issue #8: read-only workflow/run correlation from the owning Pi Durable
 * Harness. No observer owns tasks, retries work, or persists trace data.
 *
 * A TaskGraph contains only LIVE tasks. Complete the fixture's hierarchy from
 * the native parent's checkpoint/terminal step receipts and getTask() records.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Harness, TaskGraph, TaskId } from "@earendil-works/pi-durable";
import type { RunInput, RunState, WorkflowOutcome } from "./fixture-runtime.ts";

export type ExecutionNode = {
  readonly taskId: number;
  readonly parentTaskId?: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly status: "pending" | "running" | "waiting" | "completing" | "terminal";
  readonly phase?: string;
  readonly outcome?: "completed" | "failed" | "aborted" | "faulted" | "orphaned";
  readonly abortRequested: boolean;
};

export type ExecutionGraph = {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly sourceSha256: string;
  readonly revisionId?: string;
  readonly runId: number; // The parent native TaskId, not a separately generated trace ID.
  readonly conversationId: number;
  readonly nodes: readonly ExecutionNode[];
  readonly edges: readonly { readonly from: number; readonly to: number }[];
  /** False for older or faulted terminal outcomes lacking a durable child-ID receipt. */
  readonly hierarchyComplete: boolean;
  /** Live statuses are snapshots; terminal children come from durable task records. */
  readonly provenance: "pi-durable-native";
};

/** Observe the existing harness, never open another scheduler on its database. */
export async function captureRunGraph(
  harness: Pick<Harness, "getTask" | "watchTaskGraph">,
  runId: number,
  ctx: Context = BACKGROUND_CONTEXT,
): Promise<ExecutionGraph | null> {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("invalid native run ID");
  const root = await harness.getTask(runId as TaskId<WorkflowOutcome>, ctx);
  if (!root || root.kind !== "pi-workflows.fixture.run") return null;
  const input = root.input as unknown as RunInput;

  // An exact native snapshot; stop the watch immediately to release the mount.
  const watch = await harness.watchTaskGraph(ctx);
  let graph: TaskGraph;
  try {
    graph = watch.value;
  } finally {
    await watch.stop();
  }

  const ids = new Set<number>([runId]);
  let hierarchyComplete = true;
  const checkpoint = root.state.status === "pending" || root.state.status === "running" ||
    root.state.status === "waiting" ? root.state.checkpoint as unknown as RunState : null;
  if (checkpoint?.phase === "collect") {
    for (const id of checkpoint.childIds) ids.add(Number(id));
  }
  if (root.state.status === "terminal" || root.state.status === "completing") {
    const outcome = root.state.outcome;
    // Terminal checkpoints disappear from Pi Durable's live graph. The trusted
    // fixture persists direct child identities even for native failure/abort.
    // Legacy or runtime-faulted records might not have that receipt.
    const receipt = "result" in outcome ? outcome.result : undefined;
    if (receipt?.status === "unsuccessful") {
      for (const id of receipt.childTaskIds) ids.add(id);
    } else if (receipt?.status === "completed" || receipt?.status === "needs_reconciliation") {
      for (const step of receipt.steps) ids.add(step.taskId);
    } else {
      hierarchyComplete = false;
    }
  }

  // Include dynamically created live descendants whose parent is already in
  // this run, without assuming static source-code edges or scanning other runs.
  let size: number;
  do {
    size = ids.size;
    for (const node of Object.values(graph.tasks)) {
      if (node.owner !== undefined && ids.has(Number(node.owner))) ids.add(Number(node.id));
    }
  } while (size !== ids.size);

  const nodes: ExecutionNode[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const record = id === runId ? root : await harness.getTask(id as TaskId, ctx);
    if (!record) { hierarchyComplete = false; continue; } // Do not invent deleted records.
    if (id !== runId && (record.owner === undefined || !ids.has(Number(record.owner)))) continue;
    const live = graph.tasks[String(id)];
    const state = record.state;
    const status = state.status; // Native storage is authoritative, including terminal results.
    const phase = live?.state.status === "pending" || live?.state.status === "running" ||
      live?.state.status === "waiting" ? live.state.phase :
      status === "pending" || status === "running" || status === "waiting"
        ? (state.checkpoint as { phase?: string }).phase : undefined;
    const outcome = status === "terminal" || status === "completing" ? state.outcome.status : undefined;
    nodes.push({
      taskId: Number(record.id),
      ...(record.owner === undefined ? {} : { parentTaskId: Number(record.owner) }),
      conversationId: Number(record.conversationId),
      kind: record.kind,
      status,
      ...(phase === undefined ? {} : { phase }),
      ...(outcome === undefined ? {} : { outcome }),
      abortRequested: record.abortRequested,
    });
  }

  const present = new Set(nodes.map(node => node.taskId));
  return {
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    sourceSha256: input.sourceSha256,
    ...(input.publication === undefined ? {} : { revisionId: input.publication.revisionId }),
    runId,
    conversationId: Number(root.conversationId),
    nodes,
    edges: nodes.flatMap(node => node.parentTaskId !== undefined && present.has(node.parentTaskId)
      ? [{ from: node.parentTaskId, to: node.taskId }] : []),
    hierarchyComplete,
    provenance: "pi-durable-native",
  };
}
