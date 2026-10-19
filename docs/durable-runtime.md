# Native Pi Durable execution proof — issue #3

**Scope:** This is a **trusted, explicitly registered** adapter for the checked-in fixture at `fixtures/complex/workflow.ts`. It is not a general interpreter for arbitrary workflow TypeScript and introduces no scheduler or extra database.

## Execution contract

1. The host uses `loadWorkflow` to validate the canonical source and manifest. Only `dynamic_agents@1.0.0` and its supported declared capabilities are registered through `registerFixtureWorkflow`.
2. Each run pins the artifact ID, version and source SHA-256 in its **native Pi Durable task input**. The parent task ID is the run ID.
3. Phase **dispatch** filters positive inputs, creates one native child task per selected input in a single atomic `runtime.commit` with the parent's ordered child IDs/values and `waiting` checkpoint.
4. Phase **collect** reads committed child receipts via `runtime.outcomes`, checks the pinned workflow revision, and calls the **canonical checked-in `runWorkflow` function**. Ports resolve `agent()` calls from the already completed native children and validate the call order and input values. The canonical source owns loops, conditions, callback logic and approval gating.
5. The terminal result includes source hash, workflow version, output and per-child ID/input/result receipts, persisted by Pi Durable.

## External effect policy: manual reconciliation when outcome is ambiguous

An external approval is not atomic with Pi Durable's database transaction. Before calling it, the handler writes a durable `approval-intent` memo containing a stable `sourceHash:taskId:approval` key. After success, it writes an `approval-receipt` memo.

- **Receipt exists:** use the recorded approval; never re-execute the external request.
- **Intent exists, receipt missing:** do not automatically retry. Finish with structured `needs_reconciliation` and an effect key.
- **Neither exists:** the first attempt may proceed.

The test process writes the external side effect to a log then experiences **SIGKILL before receipt commit**. After reopening SQLite, the effect callback must not run again and the workflow must return `needs_reconciliation`. This is *not* exactly-once execution: a crash after intent but before actual I/O may conservatively demand reconciliation. Production providers should use server-side idempotency keys or reconciliation endpoints. Fixture hooks are pure no-ops; effectful hooks need equivalent safety mechanisms.

## Verified provider-side idempotency — issue #17

The existing **legacy** `approve(key)` port remains fail-closed: a durable intent without
a local receipt yields `needs_reconciliation` and never calls `approve` again.
A separate **explicitly opted-in** `applyIdempotently(key, request)` approval
port is available for providers that **guarantee atomic application/deduplication
for the key and entire payload**, plus a queryable, authoritative receipt.
This is a narrow approval-effect boundary, not a new workflow executor.

The request binds the canonical approval reason and the SHA-256 of the **immutable
native task input**. The operation key stays `sourceHash:parentTaskId:approval`
through recovery. On a replay with intent but no local receipt, *only this
opted-in provider* may receive the same request again. The adapter validates
`idempotencyKey`, entire `request`, and the boolean approval in the returned
`applied` or `already_applied` receipt before storing the native approval
memo. A matching repeat is reported as `approvalDisposition: "already_applied"`
in the completed workflow outcome. `unknown`, `conflict`, malformed/mismatched
receipts, and thrown provider errors **never imply success** and finish with
`needs_reconciliation`; none falls back to a legacy unsafe retry.

`tests/durable-idempotency.test.ts` uses the **same native Pi Durable task
registration and SQLite checkpoints** as the original tests. A separate process
persists an external receipt and is SIGKILLed before the Pi approval memo.
After reopening, a replay invokes the provider with the exact same key and
payload. The test-only provider uses exclusive file creation (`wx`) to model
provider-side deduplication, so two application attempts produce one stored
provider application; an incomplete or unreadable file is `unknown`. Test
probes also count native child executions and reject repeated child work.
Negative recovery tests exercise a conflicting same-key/different-payload
receipt and unreadable provider status. Ordinary completion and the old
manual-reconciliation crash test continue to run in CI.

**Limits:** The file provider is a sequential, test-only model, **not** a
production transactional provider, distributed lock or reliable idempotency
service. In production, guarantees must be supplied by the *external system*:
atomic deduplicated processing of the same full operation, consistent
authoritative receipts (or a read-only verified lookup), stable scoping of
keys across retries, and retention for at least the entire replay window.
An intent written before the call can still require manual handling if no
verified receipt exists. There can be multiple task/effect **attempts** while
only one **provider-enforced application** occurs; this is **not exactly-once
distributed execution**. No generic external-effect, authorization or
Cloudflare integration is introduced.

## Evidence and limitations

The tests exercise native task registration, dynamic parallel children, the conditional/looping trusted TypeScript workflow, checkpoint/reopen at a parent join, a separate-process hard kill, source revision rejection, and durable step receipts. **No model-backed Pi agents or arbitrary TS runtime** are provided; the fixture models an agent port using deterministic child tasks.

This proof is tied to the pinned task definitions and the same Node SQLite store. It does not prove Cloudflare Durable Object eviction, distributed coordination, transparent deployment upgrades, repeated independent start-request deduplication, execution of arbitrary untrusted code, or parity with the regular Pi adapter.

The loader's source checksum verifies the text artifact; it does not independently attest that the pre-registered compiled module matches those source bytes. Immutable deployment/build attestation and dependency locking are future requirements of [issue #7](https://github.com/mhingston/pi-workflows/issues/7). Commands and model tools follow in [issue #4](https://github.com/mhingston/pi-workflows/issues/4).

## Reproduction

Node >=22.19; CI uses 22.21.1.

```sh
npm install --ignore-scripts
npm run typecheck
npm run test:artifact
npm run test:durable
```

Hard-kill testing requires a POSIX environment that supports SIGKILL. Controlled close/reopen and actual process kill cover different failure boundaries and should not be conflated.
