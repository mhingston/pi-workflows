# Native workflow correlation contract — issue #8

This integration deliberately **does not implement telemetry**. The workflow
workbench owns the workflow revision, parent run identity and native task
hierarchy. A separate observability extension should instrument regular Pi or
Pi Durable directly for agent/model/tool/hook events, spans, retention and
export. There is no trace store, event bus, OpenTelemetry bridge or hook profiler
in this repository.

## Audited upstream contracts (pinned v1.3.0)

Dependency: `@earendil-works/pi-durable@1.3.0` (upstream
[`v1.3.0` commit `71023aec`](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable)).

| Surface | Proven native fields / behaviour | Limit |
| --- | --- | --- |
| [`Harness.getTask`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/harness.ts#L247-L251) | Persisted `TaskRecord.id`, `kind`, `conversationId`, `owner`, `state`, `input`, `outcome` | Reads one known ID, not a trace query |
| [`Harness.taskGraph`/`watchTaskGraph`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/task-graph.ts#L18-L49) | Native live task IDs, owner edges, statuses, phase, wait dependencies, owned conversation IDs | **Terminal nodes leave the live graph**; `running` can become `pending` on restart |
| [`watchEvents(harness, conversationId, context)`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/events.ts#L60-L120) | Experimental per-conversation agent messages, turns, tool-call IDs and optional native task/parent task IDs | Not emitted for the deterministic fixture's no-op `hook()` or for fake agent-port callbacks |
| [Regular Pi extension event types](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/types.ts) | `session_start`, `turn_start`, `tool_execution_start` etc.; `ctx.sessionManager.getSessionId()` | Regular Pi session ID is **not** a Pi Durable `conversationId`; no persisted join currently links the two |
| [Native durable telemetry](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md) | Host-owned optional `HarnessOptions.telemetry` for phases/restart and checkpoint spans | Configure in the separate telemetry host, not inside workflows |

The full `TaskRecord` and watch-handle interfaces are in
[`types.ts`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/types.ts#L502-L584)
and [`WatchHandle`](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/types.ts#L897-L906).

## Correlation contract actually supported

The trusted workflow's **native parent task ID is the run ID**. It is returned
as `runId` from both Pi entry points and persists on the native Run task.
`RunInput` pins `workflowId`, `workflowVersion`, `sourceSha256` and,
for published runs, `publication.revisionId` (plus provider/dependency/config
provenance). The native record supplies `conversationId`, `kind`, `owner`,
task status and outcome. The parent checkpoint includes child task IDs during
a join; after completion, the terminal `steps[]` receipts retain child IDs.
The latter is **fixture-specific**, not a general guarantee for every task
family. Parent/child links are always native task ownership edges, never guessed
from the TypeScript AST or from step names.

`captureRunGraph(harness, runId)` in
[`src/durable/run-graph.ts`](../src/durable/run-graph.ts) combines
`watchTaskGraph().value` with those persisted records, then stops its watch.
The resulting read-only `ExecutionGraph` has:

- `workflowId`, `workflowVersion`, `sourceSha256`, optional immutable
  `revisionId`, `runId` and native `conversationId`.
- `nodes[]`: native `taskId`, optional `parentTaskId`, `conversationId`,
  task kind, committed status, optional phase/outcome and abort flag.
- `edges[]` of native `from` parent task ID and `to` child task ID.

No separate correlation/trace ID, per-step identity, attempt ID, token metric,
timestamp or model/hook event is invented. Input/output payloads, checkpoint
contents and potential PII are deliberately **excluded** from the read-only
builder projection. A task in `terminal` status is a persisted record, **not**
a live task. The snapshot is not a historical timeline.

## Host-owned consumer: one harness, no extra scheduler

The workflow runtime (or another trusted component in the **same process that
owns the Harness**) supplies its existing handle:

```ts
import { captureRunGraph } from "./src/durable/run-graph.ts";
import { startEditor } from "./src/editor-server.ts";

// `harness` is the existing host-owned native Pi Durable Harness.
// `nativeRunId` came from the /workflow response, NOT a new trace ID.
const graph = await captureRunGraph(harness, nativeRunId);
// graph?.edges links actual parent/child task IDs.

const server = await startEditor("./fixtures/complex", 4175, {
  runGraph: id => captureRunGraph(harness, id),
});
```

The browser's **Native execution graph** panel accepts that run ID and calls
`GET /api/run-graph?runId=N`. It displays real task hierarchy and status next
to, but **separate from**, the static authoring graph. Refresh via **Inspect**
for a new snapshot. Invalid IDs are rejected; other workflow task kinds are
not presented as the selected package. The regular standalone
`npm run editor` is deliberately unconnected (HTTP 503) and does **not**
open a second SQLite Harness/scheduler or implicitly execute code.

For a live **native** stream rather than snapshot polling, a host can use
`harness.watchTaskGraph(context)`: `watch.value` is the initial graph,
`watch.start(async graph => { /* read-only consumer */ })` delivers changes,
and `await watch.stop()` releases it. No extra workflow event transport is
required. An observability extension may independently subscribe to
`watchEvents(harness, conversationId, context)` *where actual native agent
conversations exist*, and correlate optional tool task IDs.

## Known gaps and safety boundary

1. Completed parent/child IDs remain accessible through native persisted task
   records and fixture receipts, but arbitrary deep *terminal* descendants
   without persisted child references are not reconstructable from the live
   graph. No claim of a complete history is made.
2. A regular Pi session ID is not stored on the durable run; tracing across the
   two runtimes needs an explicit opt-in bridge when the external extension is
   implemented. Do not equate different conversation namespaces.
3. Pi regular extension hooks and Pi Durable's experimental event stream do
   not describe every custom JavaScript callback. No synthetic agent/model/hook
   events are produced from this fixture.
4. Only the explicitly trusted `dynamic_agents` adapter is executable. The
   optional editor callback is for the local, trusted host only: do not expose
   native task metadata to remote users without authentication/authorisation.
5. Live task status is a point-in-time state; on restart `running` may read as
   `pending`. Detailed trace history, spans, export, retention/redaction and
   diagnostics belong to the **separate observability project**.

## Tests

`npm run test:correlation` covers a real native waiting parent and three
dynamically created child tasks, close/reopen with unchanged task ownership IDs,
terminal receipts after native live-graph removal, invalid run IDs, and the
editor's connected vs unconnected read-only endpoint. The gate CI runs this
alongside the existing hard-kill effect/recovery tests. No model provider keys
or telemetry plugin are needed.
