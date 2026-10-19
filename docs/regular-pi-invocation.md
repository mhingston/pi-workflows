# Regular Pi invocation — issue #4

The extension at `src/pi-extension.ts` registers the `/workflow` slash command and
`run_workflow` model tool with pinned `@earendil-works/pi-coding-agent@1.3.0`.
Both call the **same** `WorkflowInvocationService`, which delegates execution to
the existing `registerFixtureWorkflow` native Pi Durable task definitions.
Regular Pi is an entry point, not a durable scheduler.

## Use

With Node >=22.19 and dependencies installed, start Pi from this repository:

```sh
npm install --ignore-scripts
./node_modules/.bin/pi --extension ./src/pi-extension.ts
```

Inside Pi:

```text
/workflow list
/workflow run dynamic_agents --input-json '{"values":[1,2,3],"requiresApproval":false}'
```

Or ask the model: "Run the dynamic_agents workflow with values 1, 2 and 3,
with requiresApproval false." Its tool call should resemble:

```json
{"name":"dynamic_agents","input":{"values":[1,2,3],"requiresApproval":false}}
```

Both paths produce `{"status":"completed","runId":<native-task-id>,"output":12}`
(with distinct monotonically allocated task IDs). The model, not a regex,
selects the tool. A model-provider credential is needed for **natural-language**
selection; direct commands do not need model inference.

## Discovery and trust

Proposed application package locations (not first-party Pi conventions):

- `<project>/.pi/workflows/<package>/workflow.ts` + `workflow.json`
- `~/.pi/workflows/<package>/workflow.ts` + `workflow.json`

The extension is explicitly loaded with Pi's **actual** `--extension` option.
These workflow paths are scanned by the app and validated by `loadWorkflow`.
The packaged `fixtures/complex` sample is a fallback so `/workflow list`
works with no user copy. Its checked-in `workflow.json` is reused by tests
and runtime, not separately recreated with a synthetic manifest.

Discovery does **not** execute discovered TypeScript. For this milestone only
`dynamic_agents@1.0.0` with the **exact installed source and manifest** is
registered. Untrusted/invalid packages are not listed as runnable and cannot
be executed. Duplicate IDs fail instead of silently selecting a package.
Project packages are ignored when Pi reports the project is untrusted.

## Permissions, lifecycle, and constraints

Inputs are validated against the trusted manifest's JSON Schema with AJV
**before** task creation. Missing backend capabilities reject invocation.
If `requiresApproval` is true, the adapter requires a **fresh interactive
confirmation** on either entry point. Declining or invoking headlessly fails
closed. Confirmation is not inferred from a model tool call. The bundled
fixture's approval port is a no-op that returns true **after** user consent;
this is **not** authority to execute arbitrary external effects.

Runs are recorded in `<project>/.pi/workflow-runs.sqlite` using Pi Durable's
native Node SQLite storage. A single service serializes local harness access,
opens a harness for each run and closes it after settling. Run IDs are the
native parent task IDs. A terminated invocation before a response can leave a
persisted task without returning its ID to the caller; recovery/status
inspection is deliberately deferred. This is not a distributed/HTTP service.

The result surface exposes the task ID, status, optional output or
`needs_reconciliation` effect key, not full inputs, credentials or child
receipts. Backend failure messages are deliberately generic. The runtime's
`needs_reconciliation` result is passed through unchanged and is never
interpreted as success or retried automatically.

Pi 1.3.0 namespaces duplicate command names as `/workflow:1` and
`/workflow:2` rather than overwriting registration. The adapter inspects
`pi.getCommands()` at session start and before explicit command execution;
**only one plain `workflow` registration is accepted**. Any namespaced
`workflow:N` entry, or another `workflow` entry, triggers a warning and
the slash-command handler refuses to run. Remove the competing extension.
Tool-name conflict checks require separate handling as part of future
cross-runtime work.

## Evidence and remaining boundaries

```sh
npm run typecheck
npm run test:artifact
npm run test:durable
npm run test:invocation
```

`test:invocation` covers the actual SQLite backend for both entry points
through a registration harness, negative inputs, code-trust, duplicated names,
capability rejection, permissions and reconciliation. It is **not** a real
terminal session or actual LLM tool-selection test. On Linux CI,
`tests/pi-cli-smoke.sh` starts the **actual** Pi CLI in a PTY, types
`/workflow list` and `/workflow run`, and checks for native run ID and
completed output without requiring model credentials. To check model selection,
run the natural-language example in a configured Pi session separately.

Not implemented: arbitrary trusted module registry, permission-scoped external
effect providers, status/cancel and cross-process coordination, full recovery
UX, code sandboxing, alternative runtimes, and trace/visual editor. Do not
claim native Pi task durability extends to Pi conversations or model calls.
