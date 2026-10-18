# Feasibility spike — Pi / Pi Durable contracts (#1)

**Status:** source-verified, runtime probes **not executed in this environment** (no outbound npm/GitHub network from the local runner).  
**Reviewed:** 2026-10-18. **Recommendation:** **conditional GO** for an adapter-based vertical slice; **NO-GO** for assuming a single transparent workflow runtime or serialisable live closures.

This note distinguishes (a) observed upstream code/docs at pinned commits, (b) executable probe code checked against those contracts, and (c) unverified integration/restart behavior. It is not a claim that the two Pi runtimes already share workflow execution.

## Pinned references

| Source | Revision / version | Evidence |
|---|---|---|
| [earendil-works/pi](https://github.com/earendil-works/pi/tree/482c1381a00d8d00bc81697e4a980c593db6803e) | `482c1381a00d8d00bc81697e4a980c593db6803e` (2026-10-18); `pi-coding-agent`, `pi-durable`, `pi-ai`, `chord` package versions **1.3.0** | [coding-agent extension types](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/src/core/extensions/types.ts), [durable README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md), [native child-task example](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/examples/24-child-tasks.ts) |
| [osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows/tree/2cb8ab3a9c2e52d0c193d572728a9ccd7afdb77a) | `2cb8ab3a9c2e52d0c193d572728a9ccd7afdb77a`, package **0.17.7** | [README](https://github.com/osolmaz/pi-workflows/blob/2cb8ab3a9c2e52d0c193d572728a9ccd7afdb77a/README.md), [package.json](https://github.com/osolmaz/pi-workflows/blob/2cb8ab3a9c2e52d0c193d572728a9ccd7afdb77a/package.json) |
| [Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows/tree/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2) | `31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2`, package **1.0.1** | [README](https://github.com/Michaelliv/pi-dynamic-workflows/blob/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2/README.md), [package.json](https://github.com/Michaelliv/pi-dynamic-workflows/blob/31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2/package.json) |

Direct dependency versions are **exact** in the probe `package.json`; transitive dependencies are **not fully locked** until a verified `package-lock.json` is generated and committed by an npm-capable runner. The upstream commit links pin the **source analysis**, not automatically the published package tarballs.

## Observed capability matrix

| Concern | Regular Pi (coding-agent) | Pi Durable | Implication |
|---|---|---|---|
| Extension loading | **Supported**: default `ExtensionAPI` factory; `pi --extension file.ts`, `jiti`; project/user extension dirs | **Different API**: explicit `defineExtension` and `createRegistry().install()` | Two integration entry points, not one exported extension with identical registration |
| Slash commands | **Supported:** `pi.registerCommand(name,{description,handler})` | **Not a native equivalent** in Durable registry | Command dispatch in regular Pi adapter; UI/API invocation for harness hosts |
| Agent-callable tool | **Supported:** `pi.registerTool({name,label,description,parameters,execute})` | **Supported:** `defineTool` installed via `defineExtension({tools})`; different execute contract and result shape | Separate tool adapters; share workflow resolution/application layer |
| Agent session | Coding-agent `ExtensionContext`/session lifecycle and `pi.on()` hooks | Conversations via `Harness.open`, `root`, `submit`, `configure` | Conversation/run identity must be translated explicitly |
| Task graph / dependencies | No documented counterpart to Durable's native checkpointed `defineTask` tree | **Supported:** `defineTask` with named/versioned phases, `tx.createTask` child ownership, `waiting` on child IDs (`allSettled`/`failFast`), `runtime.outcomes` | Native durable executor feasible for registered workflow modules; regular Pi durability needs another backend or explicit limitations |
| Persistence | Pi session entries via `appendEntry`; not a custom durable task engine | **Supported:** `defineDoc`, atomic commits, Node SQLite/JSONL, Cloudflare DO SQLite | Storage/session scopes must be designed, not conflated |
| Recovery | Pi session continuation differs; no claim of task replay parity | **Supported/documented** checkpoint and recovery on reopening storage with task definitions installed and `resume()`; a phase can rerun from its beginning | All external effects require a replay policy/receipt/compensation |
| Observability | Rich `pi.on()` lifecycle events (turn, tool, model, session) | `watchEvents()` (experimental) and live `taskGraph()/watchTaskGraph()` | Instrumentation adapters needed; live task graph is not durable complete history |
| Code Mode / dynamic scripts | Supports dynamic orchestration from extensions | Durable Code Mode uses journalled QuickJS script calls; **not** arbitrary persisted TS closures | Static source and runtime journal are distinct artifacts |
| Runtime Cloudflare | Node-oriented coding-agent not asserted compatible with Workers | **Documented** DO SQLite adapter and alarms/`onWake` integration | DO harness is feasible; actual deployment still requires a dedicated test |

Core Pi types/evidence: [extension docs](https://pi.dev/docs/latest/extensions), [source types](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/src/core/extensions/types.ts), [durable examples](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/examples/24-child-tasks.ts). **Pi Durable is explicitly experimental** and its API may change without notice.

## Reproducible smoke probes

These are tiny *executable source examples*, not production code.

```sh
# Node >= 22.16 with npm registry access
npm install --no-audit --no-fund
npm run probe:durable
# Expected: PASS: durable parent + child ownership + waiting + result (12)

npm run probe:pi
# In the interactive Pi session:
# /wf_spike hello
# Ask the model to call wf_spike_echo({ text: "hello" })
```

- [`examples/feasibility/pi-extension.ts`](../examples/feasibility/pi-extension.ts) exercises the confirmed `registerCommand` + `registerTool` signatures; tool has no side effects. Pi command loading is manual; do not expect a headless CI job to exercise an interactive command.
- [`examples/feasibility/durable-child-tasks.ts`](../examples/feasibility/durable-child-tasks.ts) installs two `defineTask`s and commits a parent that atomically creates three owned child tasks. It waits and sums them. No model/API key required.
- This probe deliberately uses **MemoryStorage** to isolate the task API. Its success would **not** prove durable persistence or process recovery.
- **Not run here:** local runner has Node 22.16 / `tsc`, but cannot resolve github.com or fetch npm dependencies. Source/typing reviewed against the pinned API declarations and official examples; do not mark checks passed until `npm install`, typecheck and both probes are run in CI/developer environment.

### Next recovery experiment (belongs in #3)

Adapt the native upstream [child-task example](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/examples/24-child-tasks.ts) to a temporary **Node SQLite** storage:
1. Pin definitions and retain task ID; start work, then close/reopen storage, reinstall registry, `resume()` and wait for recorded result.
2. Induce an **actual forced-process death** (not `close()`) between an external effect and its terminal/checkpoint commit.
3. Confirm phase can be retried and that *without* idempotency the external effect can duplicate. Repeat using a stable effect key/receipt and assert once-only business outcome.
4. Test missing/outdated task registration and `restartLimit` parking / `retryTask()`.
5. Repeat on a Cloudflare DO with `openDurableObjectSqliteStorage` and `onWake`/alarms only after Node proof.

**Documented details, not tested here:** `MemoryStorage` does not persist; Node SQLite WAL uses `synchronous=NORMAL` and may lose newest commits on power/host failure. Tasks sleeping via `sleepUntil` resume from a checkpoint; a phase cut off mid-execution **restarts from its top**. A built-in tool is replayed after interruption only if declared `replay: "safe"`; otherwise it returns an interrupted result. Even replay-safe tools with side effects need idempotency. The default `restartLimit` is 5. See [upstream recovery/storage docs](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md).

## Upstream workflow libraries — reuse assessment

**osolmaz/pi-workflows:** named TypeScript `defineWorkflow` graph with `startAt/nodes/edges`; agent, compute, notify, action/shell, checkpoint nodes, model decision helpers and explicit side-effect contracts. Discovers `.pi/workflows/` and `~/.pi/agent/workflows/` and registers `/workflow`. It runs via its **own** `better-sqlite3`-backed global server/checkpoints, *not* native Pi Durable tasks. Strong **semantics reference**; not a drop-in Pi Durable runtime or Cloudflare Worker. Arbitrary TypeScript callbacks preclude lossless reduction to an all-JSON graph.

**Michaelliv/pi-dynamic-workflows:** registers a model-callable `workflow` tool and executes model-generated JavaScript via Node `vm` to orchestrate in-memory subagents (`agent`, `parallel`, `pipeline`). Readme explicitly says prototype, no persisted/resumable runs; peer dependencies target much older 0.78 Pi packages. Strong **dynamic composition reference**, not a base durability engine.

Neither is a native extension to `@earendil-works/pi-durable` at the reviewed commits. Compatibility with Pi **1.3.0** must be tested separately, particularly for the older prototype.

## Cloudflare boundary (supported versus unverified)

- **Documented supported in Pi Durable:** `openDurableObjectSqliteStorage(ctx.storage)`; host handles alarms via `onWake` and `harness.resume()`. No automatic globally distributed workflow coordinator is implied.
- **Workers are not full Node:** Cloudflare [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) provides a subset and shims; `node:vm` is a **stub** (not a functional arbitrary-code sandbox). Runtime `eval` is restricted; startup `allow_eval_during_startup` is not permission to evaluate arbitrary code for every request.
- **Optional separate providers:** Cloudflare [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) are a candidate `CodeExecutor`; [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/) are a candidate **alternative** workflow runtime. Neither is required by this spike, and no parity test was performed.

## Decision and stop rules

**Conditional GO** for #2–#3: prototype a **single immutable TypeScript workflow source package** plus a *static, lossy-as-a-visualisation-only* graph projection and **two adapters**, not a single universal Pi workflow engine. Canonical code and manifest are fully serialisable as files, but **running closures, IO handles and all ephemeral state are not**; backend checkpoint types constrain restartable execution state. Reject graph edits that cannot safely preserve code.

**Do not yet claim:**
- Native Pi and Pi Durable execute the same workflow package unchanged, or have matching hooks/agent lifecycle/durability.
- A task is runnable as arbitrary code without prior registry installation and a compatible version.
- Pi's task graph includes complete historical trace information.
- Cloudflare Workers accept arbitrary Node sandbox packages.

**Next measurable gate:** after dependency-enabled smoke runs, implement the smallest source fixture and test native durable recovery. If the source-to-Durable mapping requires reimplementing an entire scheduler or breaks replay safety, revise #2 before investing in the UI.
