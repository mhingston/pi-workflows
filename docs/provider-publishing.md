# Provider negotiation and immutable publishing — issue #7

The runnable backend is still the **trusted native Pi Durable fixture**. This
slice introduces contracts and a content-addressed publication boundary without
implementing a second orchestrator, a general-purpose code executor or a
cross-provider lowest-common-denominator workflow language.

## Boundaries

- `src/providers.ts` defines independent `WorkflowRuntime`,
  `CodeExecutor` and `WorkflowStorage` ports. A typed registry selects a
  registered runtime by ID and refuses unknown capabilities; code executors are
  registered independently, and **none is installed by default**.
- Capabilities are machine-readable arrays. Standard names include `agent`,
  `hooks`, `approval`, `dynamic_tasks`, `native_child_tasks`,
  `timers`, `signals`, `dynamic_code` and `durable_replay`.
  `provider_<provider-id>_<feature>` grants an explicit, provider-scoped
  extension; a provider cannot claim another provider's extension.
- The Pi Durable fixture advertises its **verified subset**: agents via the
  fixture's durable child port, pure hooks, approval intent/receipt,
  runtime-selected child tasks, native children, timer/sleep, durable replay and
  `provider_pi_durable_native_tasks`. It does **not** advertise signals,
  arbitrary dynamic code execution or general-purpose effectful hooks.
- Regular Pi is a **command/tool adapter**, not a registered runtime provider.
  Calling through Pi does not grant the durability, task semantics or replay
  guarantees of Pi Durable. Selecting `regular_pi` as an execution provider
  fails closed; no substitute runner is constructed.

## Publish / run

`createWorkflowInvocationService` now exposes `publish(name)`,
`run(name, input)` and `runRevision(revisionId, input)`. The existing Pi
command/model-tool paths still use `run`; both go through the same publication
and native execution service. A default run publishes/deduplicates the exact
trusted source first and then executes its pinned revision. `publish` does not
execute or import arbitrary user-authored TypeScript.

The local store lives at `.pi/workflow-publications/<sha256>.json` (override
with `publicationDir`). The immutable envelope includes the exact original
source/manifest/layout bytes, installed dependency versions, runtime ID and
version, and implementation fingerprint. The publication ID hashes the whole
envelope. Writes are create-only; all reads re-verify the envelope fingerprint,
source digest, dependency pins and capabilities. Tampered revisions fail closed.
A new source, dependency, implementation or layout yields a different revision.

For this bounded adapter, the installed Pi Durable package version is read from
`node_modules` and must equal the manifest's exact dependency version; the
implementation hash covers both the native task adapter and invocation adapter
source. Publishing version ranges or unknown/mismatched dependencies is
rejected. This is **local integrity detection**, not cryptographic authorship
attestation, a tamper-resistant filesystem or an npm supply-chain signature.

Each native run's persisted input includes the publication revision ID, runtime
identity/version/implementation hash, exact dependencies and input/configuration
hashes, alongside the pre-existing source fingerprint and consent assertion.
The native run validates this pin during dispatch and collect. On resume, a
host must register the **same** adapter/revision; if unavailable it must refuse
to resume rather than reroute to another implementation. Storage and trace
inspection do not assert exactly-once external effects.

## Explicit limits

Only `dynamic_agents@1.0.0` backed by the checked-in trusted module can be
executed. Publication alone never authorizes arbitrary source imports or code
execution. The registry exposes a `CodeExecutor` contract, not a deployed
sandbox. Provider-specific options stay in TypeScript source/adapter code and
must declare a corresponding provider capability in the manifest. The editor
graph remains illustrative metadata; no provider semantics are pushed into it.

Provider selection in this slice is programmatic (`runtimeId`), not a user
interface; the only registered runnable runtime is `pi_durable`. Future
providers must independently prove their supported capabilities and native
recovery guarantees with contract and restart tests. The local publication
store does not yet provide distributed coordination, retention/GC, signatures,
remote storage or migration for an upgraded native task definition.

## Verify

Requires Node >=22.19 and installed pinned dependencies:

```sh
npm install --ignore-scripts
npm run typecheck
npm run test:providers
npm run test:invocation
npm run test:gate
```

`tests/providers.test.ts` exercises supported/unsupported negotiation,
provider-only capability gates, exact dependency locks, immutable source
snapshots, corruption rejection, recorded native provenance and refusal to drift
when a draft or runtime descriptor changes.
