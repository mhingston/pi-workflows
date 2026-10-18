# Issue #1 — Pi workflow feasibility (API audit)

**Date:** 2026-10-18  
**Status:** source-audited and accompanied by executable probes; see PR checks for execution evidence.  
**Conclusion:** **GO** for a *small Pi Durable-native vertical slice with separate regular Pi integration*. **NO-GO** for claiming that arbitrary Pi extension source or arbitrary running JS can be directly moved between execution engines without translation, provider-specific handling, or restrictions.

## Sources pinned for this spike

The release packages used by the probes are **1.3.0** of `@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord`. Released API source was inspected at **[`earendil-works/pi@v1.3.0 / 71023ae`](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0)**, along with newer **[`main@482c138`](https://github.com/earendil-works/pi/tree/482c1381a00d8d00bc81697e4a980c593db6803e)** (2026-10-18). The package is explicitly marked **experimental** and may change.

Other reference implementations:
- [`osolmaz/pi-workflows@2cb8ab3`](https://github.com/osolmaz/pi-workflows/tree/2cb8ab3a9c2e52d0c193d572728a9ccd7afdb77a) (2026-10-08), [README](https://github.com/osolmaz/pi-workflows/blob/2cb8ab3a9c2e52d0c193d572728a9ccd7afdb77a/README.md).
- [`Michaelliv/pi-dynamic-workflows@31b2aca`](https://github.com/Michaelliv/pi-dynamic-workflows/tree/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2) (2026-05-31), [README](https://github.com/Michaelliv/pi-dynamic-workflows/blob/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2/README.md).

These are source/contract references, **not dependencies** of this project. **CI found upstream API drift:** the newer main branch exposes `TaskRuntime.sleepUntil()`, but npm release 1.3.0 exposes invocation-bound `TaskRuntime.sleep(until, context)` instead. Source evidence from an unreleased branch is not evidence for a published npm API; use the release-tag signatures.

## Observed API and guarantees

| Question | Status | Evidence and implication |
| --- | --- | --- |
| Can regular Pi register a slash command and model-callable tool? | **Supported** | [extension docs](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/extensions.md), [`ExtensionAPI`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/src/core/extensions/types.ts), [hello](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/examples/extensions/hello.ts), [todo command](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/examples/extensions/todo.ts). Register via `pi.registerCommand` and `pi.registerTool`. Does not itself supply durable workflow state. |
| Can Pi Durable register custom task definitions? | **Supported** | [`defineTask`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/tasks.ts), [`TaskDefinition` / `TaskRuntime`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/types.ts), [`Extension.tasks`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/types.ts). Named, versioned, finite phase maps and explicit `abort` handlers. |
| Can durable tasks create children and join? | **Supported** | [upstream child-task example](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/examples/24-child-tasks.ts). Use `runtime.commit(tx => tx.createTask(...))` and commit a `waiting` checkpoint with `on` + `failFast`/`allSettled`. `runtime.outcomes()` reads the completed children. |
| Persistent recovery with SQLite? | **Supported, bounded** | [durable README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md), [Node SQLite adapter](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/storage/sqlite/node.ts). Reopen the same SQLite store and resume/wait. A `running` phase can restart **from its top**; not exactly-once execution of I/O. |
| Durable timers and waits? | **Version-dependent** | Release **1.3.0** has `runtime.sleep(until, context)` (invocation-bound; a phase may rerun on restart). Newer **unreleased main** has `runtime.sleepUntil(until, checkpoint, context)` (durable phase-boundary sleep). Do not assume the latter exists in 1.3.0. |
| Custom durable state? | **Supported** | `defineDoc` with typed JSON state, in the same atomic commit path as task creation and entries. Scope/history/fork policies need a deliberate design. |
| Observability? | **Partial** | [`watchTaskGraph`, `taskGraph`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/types.ts) cover **live** tasks only; [`watchEvents`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/events.ts) derives turn/tool events from commits. Neither is a complete permanent per-hook trace. |
| Hooks? | **Supported, different shapes** | Regular Pi uses event handlers registered with `pi.on(...)`; Pi Durable's `hook(GenerationTask,...)` / `hook(ToolTask,...)` are attached to task types through installed extensions. Pi Durable also allows **custom task hooks** via a typed `hooks` map and `runtime.hooks.each()`. No single shared hook API exists. |
| One built-in cross-runtime workflow DSL or JSON schema? | **Unsupported** | No shared first-party DSL in the inspected package exports. Normal Pi uses extension factories; Pi Durable uses `defineTask` phase maps and `defineExtension` registrations. Our portable authoring package remains **proposed application logic**. |
| Execute arbitrary `workflow.ts` source dynamically on Cloudflare Workers? | **Not directly supported by default** | Workers restrict request-time `eval`/`new Function` and dynamic imports that are not bundled; [Workers runtime analysis](https://blog.cloudflare.com/workers-vitest-integration/), [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/). [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/getting-started/) provide an **optional distinct code-isolation provider**, with bindings and egress policy. |
| Full source fidelity and semantic visual round-trip for arbitrary TS? | **Unknown / cannot be generally guaranteed** | Retain original source on no-op save. Recognized AST edits can be bounded; arbitrary callbacks/closures, generated graphs and side effects cannot in general be converted back and forth through a static DAG. Code view and opaque regions are required. |

### Critical semantics

1. **Committing a checkpoint is the durability boundary.** Release 1.3.0's `runtime.sleep()` does not checkpoint. A phase can rerun from its beginning if interrupted before its commit. I/O occurring before the commit can happen twice. Built-in model/tool calls have their own recovery controls; custom code must define effect/idempotency semantics.
2. **`Tx.createTask` and checkpoint update in one `runtime.commit`** prevent duplicate child creation *as a committed batch*. The parent stores child IDs in its checkpoint; `runtime.outcomes()` is called in a later phase.
3. **`TaskDefinition.version` is not a full workflow-package pin.** A running task retains a persisted definition version and can use `migrate()`, but source/dependency hashes, published-version isolation and history inspection remain our responsibilities.
4. **The Pi Durable registry is code, not a workflow definition repository.** A missing task kind on reopen can produce an orphaned task. Retire definitions only with explicit migration/compatibility policy.
5. **Storage scope is bounded.** Harness operates over one session/storage; Node SQLite/JSONL and Cloudflare DO storage are distinct adapters. Distributed global queues/worker routing and cross-DO ownership are not provided by these APIs.
6. **Pi extensions are trusted code.** Regular Pi's extension executes with user-process permissions; importing arbitrary workflows as code is a security decision. A web editor cannot silently run user-supplied TypeScript on the host.

## Upstream workflow comparisons

**`osolmaz/pi-workflows`**: named TypeScript graph definitions (`defineWorkflow`, nodes/edges), `/workflow` invocation, persisted runs, checkpoints and a SQLite-backed server/terminal viewer. It gives us **workflow semantics and UX patterns**, but its own server/state runtime is not Pi Durable's task registry. Dynamic TS callbacks mean its graph is not fully representable by a plain JSON flowchart.

**`Michaelliv/pi-dynamic-workflows`**: generates a script at runtime and uses `agent()`, `parallel()`, `pipeline()`, `phase()` in a Node VM with in-memory Pi subagents. It provides a **dynamic execution / visual progress** reference, but explicitly lacks persisted/resumable runs and is not a Pi Durable runtime.

Do **not** import either engine as a dependency merely to get node types. That would introduce a separate scheduler and may break Workers compatibility.

## Portability proposal for issue #2

1. Separate an **authoring definition / source artifact** from backend-native execution. The source is portable as a package; the runtime is **capability-checked**.
2. Prototype a small TypeScript authoring API with stable named steps, dynamic regions and optional arbitrary code callbacks. Define a manifest with provider requirements, inputs, version/hash and dependency identities. `layout.json` is non-authoritative.
3. For Pi Durable, either compile/register trusted workflow modules as versioned **native tasks** or interpret a typed published artifact through one registered durable task, depending on the concrete evidence from #3. Runtime-loaded TS is **not** a native Pi Durable facility.
4. For regular Pi, invocation via command/tool can call an adapter that runs the authoring workflow in-process or through an explicitly selected backend. Never claim local Pi has Pi Durable replay guarantees.
5. Reject unsupported constructs at publish/run, preserving arbitrary code in source. A visual editor must treat unrecognized or dynamic code as opaque, and **refuse** unsafe rewrites. Source **round-trip fidelity** is an achievable test; unrestricted behavioral equivalence across different runtimes is not a sensible guarantee.
6. Record the capability difference between providers (durable child tasks, prompts/tools/hooks, waiting signals, code execution, storage scopes, long-running ownership). Do not prematurely implement every provider.

## Executable probes and verification

- [`spikes/issue-1/regular-pi.ts`](../spikes/issue-1/regular-pi.ts): slash command and model-callable tool use one deterministic response helper. A manual Pi CLI test is required to confirm interactive UX; typechecking alone does not prove tool dispatch.
- [`spikes/issue-1/durable.ts`](../spikes/issue-1/durable.ts): creates two SQLite-backed child tasks with invocation-bound `sleep()`, waits for the parent's committed `waiting` checkpoint, calls `harness.close()`, reopens storage, and asserts final sum. This demonstrates phase reattempt after shutdown, not a persisted wake deadline. Controlled shutdown is **not** an injected crash or Cloudflare eviction.
- [run instructions](../spikes/issue-1/README.md). CI typechecks both against pinned npm versions and executes the SQLite reopen probe with Node >=22.19.

**Test reporting rule:** Source API observations are not runtime test results. Check PR Actions for actual passes/failures; the authoring container cannot install the npm dependencies due network restrictions. The PI CLI interaction and hard-kill/DO recovery remain **unverified** until explicitly tested.

## Go / no-go

**GO** with a limited, source-preserving authoring API plus **two adapters** (regular Pi invocation + Pi Durable-native execution). First prove a trusted, pinned child-task workflow and no-op round-trip.

**NO-GO** for treating plain TypeScript as universally replay-safe; a single unqualified `WorkflowRuntime` that promises identical capabilities on every provider; making a visual DAG the source of truth; or running user-uploaded code in the host without a security boundary.

### Risks / follow-ups

- [#2](https://github.com/mhingston/pi-workflows/issues/2): canonical file format, opaque regions, source hashes and round-trip fixtures.
- [#3](https://github.com/mhingston/pi-workflows/issues/3): real hard-stop/restart fault injection, durable ownership boundaries and I/O idempotency.
- [#4](https://github.com/mhingston/pi-workflows/issues/4): real Pi tool/command integration with permissions and invocation UX.
- [#5](https://github.com/mhingston/pi-workflows/issues/5): AST-aware source projection/editing, not a lossy DAG serializer.
- [#7](https://github.com/mhingston/pi-workflows/issues/7): capability negotiation and immutable publishing.
- [#8](https://github.com/mhingston/pi-workflows/issues/8): telemetry around individual hooks and historical traces.
- [#9](https://github.com/mhingston/pi-workflows/issues/9): independent Cloudflare Workers/Workflows portability and security spike.
