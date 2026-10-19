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
