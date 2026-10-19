# Issue #9 — optional Cloudflare provider spike

**Decision (2026-10-19): GO for an opt-in Dynamic Workers CodeExecutor experiment; NO-GO for adding either Cloudflare provider to the default runtime. Defer a Cloudflare Workflows runtime adapter.**

The existing provider contract from [issue #7](provider-publishing.md) already separates code isolation (CodeExecutor) from durable workflow ownership (WorkflowRuntime). This is a **bounded investigation, not a production adapter**. It introduces no Cloudflare dependency, registration, new workflow language, local-to-cloud bridge, or alternate scheduler into Pi Durable.

## Capability matrix

| Question | Existing Pi Durable fixture | Dynamic Workers as CodeExecutor | Workflows / Dynamic Workflows as alternative WorkflowRuntime |
| --- | --- | --- | --- |
| Owns workflow durability and replay? | Yes, through native task/checkpoint storage | **No**, runs an isolated code call | **Yes**, through Cloudflare step checkpoints |
| Trusted native Pi agent/child tasks? | Bounded fixture supports native children | Not part of a code isolate | Not compatible by default; requires a separate adapter |
| Dynamic branching and parallelism? | Dynamic children with native join in the fixture | Only ordinary JS within one invocation | Cloudflare step-based programming; parity with native Pi children unproven |
| Timers and externally supplied signals? | Timers in fixture; signals not advertised | Neither | Native sleep, sleepUntil and waitForEvent |
| Arbitrary JS/TS modules? | Only checked-in trusted module | JS modules loaded on demand with approval and isolation | Runtime-loaded Workflow classes possible through Dynamic Workflows; **not** arbitrary Pi TypeScript compatibility |
| Credentials and network? | Host's Node privileges; only trusted code | Explicit binding policy and network egress control required | Cloudflare bindings; per-step security design required |
| Versioning? | Source/dependency and native adapter pins (#7) | Code + wrapper + policy must be immutable for a given Loader ID | Resume must reload exact compatible definition and routing metadata |
| Recovery semantics? | Checkpoint/reconciliation receipts as documented | No durable receipt; retried code can execute again | Completed steps persist results; interrupted steps may retry external effects |
| Evidence in this PR? | Previously demonstrated in #6 | Offline mocked contract tests and optional fixed-source Wrangler smoke | Source research only, **no execution or recovery proof** |

## Dynamic Workers: API, security and cost

Cloudflare's Worker Loader provides two modes: load() constructs a one-off Worker; get(id, callback) uses a stable identity and may reuse a warm isolate. **Neither guarantees that the same isolate handles two calls.** The code callback must always resolve to the same modules/configuration for a stable ID; when source or policy changes, the ID must change. Runtime JS modules have a defined mainModule, and user code can be a *separate* module rather than interpolated into a wrapper.

**Security-critical default:** globalOutbound is inherited from the parent when omitted, often granting unrestricted Internet access. The proof explicitly sets globalOutbound to null (blocking fetch and connect), supplies an empty env (no secrets or service bindings), and requests strict CPU/subrequest limits. Source must have an **independent host-side authorization check** against the exact SHA-256 hash; an ApprovedCodeUnit's authorizationId is only a reference and does not grant permission by itself. Approval must bind the actual caller/tenant, executable revision, policy, and expiry in a real adapter. Hash matching is **not** authorship verification. The PoC caps source, serialized input and response sizes and does not return user-code stacks or user inputs in error responses.

The platform supports per-invocation CPU and subrequest caps, but **CPU time is not a wall-clock timeout**. A production execution service additionally needs request deadlines, concurrency controls, explicit cancellation limitations, admission/rate limits, audit and redaction, immutable publication and strong identity checks. External side effects can be ambiguous when an invocation is interrupted; blind replay is unsafe. Neither a Worker isolate nor a code digest supplies exactly-once effects. Treat potentially hostile user-authored code differently from the repo's current trusted and locally installed modules.

As documented in October 2026, a Worker request can have **4 distinct Dynamic Workers** in flight; a Durable Object can have **10**. Dynamic Workers require Workers Paid; pricing accounts for unique Worker creations, invocations and CPU. The plan starts at **US$5/month**; there are usage allowances and possible overages. Choosing a stable ID through get() avoids the one-new-Worker-per-invocation cost of load(), but do not infer actual latency or spend from this static experiment. Dynamic Python modules have slower startup than JS according to the API docs.

**Do not run hostile code under local Wrangler or Miniflare.** Cloudflare says local workerd/Miniflare is not a hardened isolation boundary. Any genuine adversarial test must use a deployed platform test account with no secrets, protected ingress and controlled spend, after security review. Do not feed PII, raw model credentials or sensitive data to Dynamic Workers or their logs.

## Proof and reproduction

The small optional sample is in [spikes/cloudflare](../spikes/cloudflare/):

- code-executor.mjs provides a structural CodeExecutor implementation that accepts an injected Cloudflare Worker Loader and an authorizer; it is **not** registered or imported by the real Pi invocation service.
- smoke-worker.mjs executes a **fixed, benign** positive-number-sum module via the Loader. It takes no user source/input from HTTP. It is for manual development only, not a public deployment.
- wrangler.jsonc provides the optional Worker Loader binding. There are no Cloudflare runtime dependencies in the root package.
- code-executor.test.mjs checks authorization/integrity rejections, no inherited env, network-denial configuration, resource caps, stable IDs, bounded responses and hidden error details.

Run the offline tests from the root:

~~~sh
node --test spikes/cloudflare/code-executor.test.mjs
~~~

Optionally, with Wrangler installed on a machine where Worker Loaders are supported:

~~~sh
npx wrangler dev --config spikes/cloudflare/wrangler.jsonc
curl http://localhost:8787/smoke  # expected: {"result":6}
~~~

The Node tests use a **fake Loader that never executes supplied source**, so they verify adapter control flow and the passed API configuration, **not actual Worker sandbox isolation**. The real Wrangler smoke has not been run in this PR. The production CodeExecutor contract would also need a full *deployed artifact* fingerprint and publication binding; the PoC descriptor's wrapper/policy hash is illustrative and is not sufficient as a production adapter identity. Its approval callback is an injection boundary, not a complete IAM system. Do not deploy the smoke endpoint publicly without authentication, rate limiting and service controls.

## Compatibility with Pi Durable on Cloudflare

Pi Durable **already has a Cloudflare Durable Objects implementation example** in [earendil-works/pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare) and a [technical walkthrough](https://earendil.com/posts/pi-durable-on-cloudflare/). It uses a Pi session per Durable Object and Durable Object SQLite through openDurableObjectSqliteStorage. This is strong evidence that **Pi Durable itself can be hosted on Cloudflare**, not evidence that this repository's Node-specific local publication store, editor, SQLite file paths, terminal Pi extension or CLI can be deployed to a Worker unchanged.

A Worker Loader binding belongs inside a Cloudflare-hosted Worker/DO. Calling it from the existing Node-hosted Pi Durable application would require a **separately authenticated** RPC/HTTP gateway with execution, audit and receipt protocols. No such bridge or public arbitrary-code endpoint is part of this spike.

## Cloudflare Workflows adapter decision

Cloudflare Workflows provides its own durable step engine: step.do(), step.sleep(), step.sleepUntil() and step.waitForEvent(). The [Dynamic Workflows library](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/) lets loaded workflow classes resume by associating an instance with routing metadata. Its documented limits, pricing, instance retention and retry model are independent of Pi Durable's task storage. Metadata persisted for routing **must not contain secrets**. Workflows uses steps, not native Pi Durable child tasks/hooks, and external effects still require idempotency controls.

**Do not open a separate runtime-adapter issue yet.** There is no concrete v1 requirement that needs Cloudflare Workflow ownership when Pi Durable-on-DO already exists. A second runtime would add substantial semantic, release-pinning, migration and testing work for uncertain value. Revisit only for an independently validated case such as externally signalled, multi-tenant Cloudflare-native automations that need Workflows-specific features. At that point, create a *standalone alternative WorkflowRuntime issue* with its own capability negotiation, immutable revisions, crash/retry/receipts, event-wait, version-migration, cost and security acceptance criteria. **Do not nest Cloudflare Workflows inside each Pi Durable task.**

## Primary sources checked 19 October 2026

- [Dynamic Workers getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/) and [API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/).
- [Egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/), [concurrency limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/), [pricing](https://developers.cloudflare.com/dynamic-workers/pricing/).
- [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/), [Workflows API](https://developers.cloudflare.com/workflows/build/workers-api/), [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/).
- [Miniflare local sandbox warning](https://developers.cloudflare.com/dynamic-workers/examples/dynamic-workers-playground/) and [Pi Durable-on-Cloudflare reference](https://github.com/earendil-works/pi-durable-cloudflare).
