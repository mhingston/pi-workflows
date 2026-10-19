# Native Pi Durable workflow proof (issue #3)

This is a bounded execution and recovery proof, not a generic workflow interpreter. Pi Durable 1.3.0 is the only scheduling and checkpoint owner.

## Architecture

- [Artifact loader](../src/artifact.ts) verifies the canonical workflow source hash and metadata but never evaluates imported TypeScript.
- [Native adapter](../src/runtime/pi-durable.ts) accepts a preinstalled trusted task and a loaded artifact. Before starting, it checks workflow ID, version, source hash, dependency identities and capability requirements. It stores run ID, JSON input and pinned source revision in the native task input.
- [Trusted workflow](../fixtures/durable/workflow.ts) registers parent/child native Pi Durable tasks with three parent phases: select, collect, effect. The positive branch atomically creates child tasks and enters a native waiting checkpoint, then persists child receipts in the next checkpoint. The skipped branch returns without external effects.
- No separate run scheduler, task database or Node-specific orchestration runtime has been added. The workflow is native registered TypeScript code, rather than a lossy interpreted JSON DAG.

## Crash and idempotency demonstration

[Integration tests](../tests/durable.integration.test.ts) spawn a subprocess with file-backed Pi Durable SQLite storage. It commits a parent/children checkpoint, runs the selected tasks, and performs an external effect. The child process emits EFFECT_APPLIED after that external effect but before the terminal Pi checkpoint; the parent test sends SIGKILL without gracefully closing the Harness. A second process opens the same SQLite DB and waits for the original task to complete.

The simulated [external service](../tests/support/external-effect.ts) offers atomic idempotent receipt creation using exclusive file writes, separate from Pi Durable's persistence store. The test asserts two effect *attempts* with the *same key*, only one external side-effect receipt, a recovered task result with an already-applied disposition, and original child results. A conflicting receipt causes a failed run requiring manual reconciliation.

Tests also cover conditional skipping, run identity and revision pin, unavailable backend capabilities, and ordinary completion.

## Critical constraints

- **No exactly-once promise.** Pi Durable may rerun a phase from its start. Only the external provider's idempotency/status query/compensation can close the gap between an external effect and the Pi commit. A local after-the-fact receipt is insufficient. This fixture uses an idempotent *external* operation as its proof.
- **Trust and pinning.** Workflow TypeScript is installed ahead of time, never runtime-evaluated from an upload. The adapter validates the artifact's metadata against a trusted registered task. Each parent phase refuses a persisted revision that does not match the installed module. Full immutable code publishing and migration policy remain #7.
- **Scope.** The sample's children perform deterministic calculations so fault injection needs no model credentials. Real agent calls, approvals, Cloudflare Durable Object eviction and Worker compatibility are not demonstrated yet. Regular Pi invocation is #4; the cross-runtime proof is #6.
- **Source expressiveness.** A trusted native TypeScript module can use the underlying Pi primitives directly, but this is not a generic runtime that can automatically execute every arbitrary callback in any workflow source.
- **Input validation.** Generic JSON Schema enforcement and caller authorization are required before exposing arbitrary inputs through slash commands or model tools (#4).

## Reproduce

~~~sh
npm install --ignore-scripts
npm run typecheck
npm run test:artifact
npm run test:durable
~~~

This proof is built for Node >=22.19 with a pinned CI test on Node 22.21.1.
