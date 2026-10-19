# Release gate #6 — one cross-runtime workflow, no second engine

**Scope:** An evidence-backed vertical slice for the exact, trusted
\`dynamic_agents@1.0.0\` source package. This is a test/demo gate, **not**
another runtime, a workflow JSON language, or a claim that ordinary Pi is durable.

## Reproduce

Requires Node >=22.19 (CI pins 22.21.1), npm and Linux/POSIX SIGKILL support.

~~~sh
npm install --ignore-scripts
npm run typecheck
npm run test:gate
npm run test:durable
npm run test:invocation
npm run test:editor
bash tests/pi-cli-smoke.sh # Linux util-linux / PTY; no model key required
~~~

The [cross-runtime gate CI](../.github/workflows/gate.yml) runs all of these,
including artifact contract tests. Each test uses temporary workflow package
copies and temporary native SQLite stores; no external LLM credentials are needed.

For a manual two-window demo:

~~~sh
npm run editor -- --workflow ./fixtures/complex
# Open http://localhost:4175, inspect branching, Promise.all, dynamic and
# opaque source regions. Click Save without edits and verify workflow.ts is unchanged.

./node_modules/.bin/pi --extension ./src/pi-extension.ts
# In Pi:
/workflow list
/workflow run dynamic_agents --input-json '{"values":[2,-4,3],"requiresApproval":false}'
~~~

The expected command output has \`status: completed\`, a **native** run ID and
\`output: 10\`. A model can call the explicitly registered \`run_workflow\` tool
with the same name and JSON input; model *selection* requires a configured model
provider and is **not** proven by offline tests.

## Exactly what the fixture proves

| Stage | Evidence |
| --- | --- |
| Plan / dynamic branch | Canonical \`workflow.ts\` selects positive values; the native dispatch phase creates one task per selected value, not a guessed static edge. This is deterministic planning, **not** an LLM planner. |
| Parallel | Native child tasks checkpoint atomically with a parent waiting join; the canonical \`Promise.all\` consumes the persisted child receipts. |
| Conditional gate | \`requiresApproval && total > 3\` determines whether an external approval effect is needed. |
| Explicit approval / wait | Regular Pi asks for fresh interactive confirmation **before** creating an approval-requiring run. Native Pi Durable stores approval intent and receipt memos and does not silently retry uncertain effects. |
| Final output | Canonical callback doubles the total; the terminal native outcome stores output, source hash, version and stable child task IDs. |
| Editor | Local browser loads the very same workflow directory, projects static/dynamic/opaque AST regions, no-op saves with exact source bytes, persists layout hints, and refuses unsafe property/structural edits. |

\`npm run test:gate\` demonstrates the chain using the actual editor HTTP API and
Pi's **registered command/tool handlers** against the same trusted package. It
then reopens the native SQLite DB to inspect run IDs, child receipts, source
revision pins and user-confirmation metadata. A separate test closes/reopens
Pi Durable at an actual persisted parent wait checkpoint, then verifies the
final result and effect count. The separate \`test:durable\` process-kill proof
exercises SIGKILL **after an external effect but before its receipt**; the
restarted process must return \`needs_reconciliation\` without replaying it.
\`pi-cli-smoke.sh\` also invokes the real Pi executable to validate the slash
command without a model service. The registered tool handler is exercised
offline; autonomous LLM choice of that tool is not.

## Run records and distinct approval concepts

Runs store in native Pi Durable's task **input**:
\`workflowId\`, \`workflowVersion\`, \`sourceSha256\`, original validated input,
and \`interactiveApproval\`:

- \`approved\`: the regular Pi command/tool prompted, and the user consented
  before the native task was created.
- \`not_required\`: the caller did not request the approval route.
- \`not_recorded\`: the native task was started directly, outside the regular Pi
  interactive-confirmation boundary; **do not** treat this as approved.

This is a recorded provenance assertion from the trusted invoker, not a cryptographic
user identity, and is distinct from the runtime's external approval decision. The
**external** Boolean decision is stored in an \`approval-receipt\` native memo
after an \`approval-intent\` memo. Effect ambiguity is recorded via a terminal
\`needs_reconciliation\` result and stable effect key. Declined Pi confirmations
abort **before** native task creation and are therefore not recorded as runs.
Native tasks launched directly for recovery tests intentionally show
\`not_recorded\`.

## Provider capabilities and limitations

The regular Pi extension is only a **command/model-tool entry point**. It does
not own durable tasks, Pi session state or model-call checkpoints. The native
Pi Durable runtime owns SQLite tasks, restart, child joins and effect memos.
The service rejects unsupported capabilities before creating a run. Passing
source text, a manifest or a graph between these surfaces does **not** grant
identical guarantees or permit execution of untrusted arbitrary TypeScript.

The editor never runs workflows. Its static edges cannot represent runtime
task creation; only actual native child task records can show resolved fan-out.
Graph rewrites, custom arbitrary task families, a sandboxed code executor,
distributed storage recovery and deployment publishing are **not** proven.

## Gate verdict / scaling decision

**Conditional GO** for continuing with the single **trusted, source-authoritative,
Pi Durable-native** implementation and separately adding explicit provider/publish
policies (#7). The existing bounded graph projection is adequate for no-op saves
and controlled properties; real Pi commands, registered model-tool handler and
native kill/restart tests cover the local workflow lifecycle.

**NO-GO** for widening into arbitrary graph rewriting, claiming ordinary Pi
conversation durability, generalizing this adapter to untrusted user-authored
code, or promising exactly-once external effects. An untrusted execution boundary,
stable source/build attestation, provider capability contract, immutable publishing,
and runtime tracing remain separate work (#7–#8).

**Evidence boundaries:** The gate runs deterministic agent-port child tasks,
not real model-backed agents; offline tests invoke the registered tool handler,
not model intent selection; the interactive prompt is a simulated, positive
UI confirmation in tests while the actual CLI smoke uses a no-approval run.
Do not describe those as live human approvals or online model runs.
