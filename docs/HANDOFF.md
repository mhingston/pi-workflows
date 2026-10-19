# Architecture & implementation handoff

**Project:** `mhingston/pi-workflows`  
**Status:** proposed; feasibility not yet demonstrated  
**Last reviewed:** 2026-10-18  
**Start with:** [#1 — verify upstream contracts](https://github.com/mhingston/pi-workflows/issues/1)  
**Release gate:** [#6 — one cross-runtime vertical slice](https://github.com/mhingston/pi-workflows/issues/6)

## 1. Product outcome

Build an **n8n-like workflow workbench for Pi**, with a browser graph editor, chat/tool/command invocation, and reusable agent workflows. Use **Pi Durable's native tasks and checkpoints** as the intended default backend when durability is required. Ordinary Pi is a first-class entry point, with explicit differences in runtime guarantees.

Users should be able to:
1. Create workflows in TypeScript or graphically, and round-trip between those representations without erasing unsupported code.
2. Discover and invoke named workflows with `/workflow run <name>` or an explicit agent tool (`run_workflow`), including a natural-language request such as “run X workflow”.
3. Compose agents, tools, conditions, loops, parallel work, custom callbacks, approval steps and **runtime-generated** child work.
4. Pick a compatible execution provider; inspect requirements before running.
5. Observe a live/historical execution graph and individual turns/hooks independently of how the workflow was authored.

We are **not** building a Temporal clone, a new durable queue engine, or a separate workflow scheduler for Pi Durable. We are also **not** claiming Pi exposes a first-party workflow JSON standard: the package format below is **ours**, built around native Pi/TypeScript primitives.

## 2. Ground rules / architectural decisions

1. **Preserve expressiveness, not just graphability.** Arbitrary TypeScript source is representable as source text; an n8n-style graph is a *projection* and must not replace behavior. Not all runtime-created task edges can be known before execution.
2. **One canonical source package.** A workflow's TypeScript source is authoritative. Manifest metadata and layout are derived/adjacent artifacts and must not override the execution semantics.
3. **Native durability is owned by the runtime.** A Pi Durable adapter must use its real task/checkpoint/storage APIs; a Cloudflare Workflows adapter (if ever built) is an *alternative* durability owner, not a second wrapper around every task.
4. **Provider capability validation, no silent degradation.** Regular Pi, Pi Durable, Cloudflare Dynamic Workers and Cloudflare Workflows are not interchangeable. Validate and reject unsupported requirements before start/publish.
5. **Observability is separate.** Trace ingestion is read-only and must never be the source of truth for workflows or a command channel for mutations.
6. **Trusted code first.** Initially load version-pinned, locally registered workflow modules. Runtime compilation/execution of user-authored code requires isolation, authorization and resource limits. Never assume that serializable source equals safely executable source.
7. **Failure semantics are explicit.** Durable replay can repeat an interrupted phase. Persist receipts and use idempotency keys, compensations or manual reconciliation for external effects. Never promise exactly-once execution without evidence.

### What “lossless” means

- **No-op round trip:** loading, displaying and saving an unmodified source does not change source bytes (or applies an *explicitly opted-in* formatter with a demonstrated semantic-preservation guarantee).
- **Visual edit:** only a construct with an unambiguous, stable source mapping may be rewritten. Unsupported code stays byte-for-byte unchanged. If mapping is ambiguous, **reject the visual edit** and offer code editing.
- **Dynamic computation:** preserve arbitrary functions/closures *as source* and model live results in the **runtime execution trace**, not as invented static graph edges.
- **Execution state:** serializing code does **not** serialize arbitrary live closures, process memory, filesystem handles or in-flight network effects. Durable state must meet the backend's persistence rules.
- **Portability:** package/source portability does **not** mean every feature executes on every backend. Provider-specific primitives remain expressible through capability-gated code and adapters.

## 3. Workflow artifact contract (provisional; #2 decides)

Use a versioned workflow directory with these files:

```text
<workflow-name>/
  workflow.ts       # Canonical TypeScript source / executable workflow definition
  workflow.json     # Name, artifact version, entry point, schemas,
                    # dependencies, provider capabilities, source hash
  layout.json       # Optional editor projection and stable source anchors
```

A file under `.pi/workflows/` or another Pi discovery path may be an adapter entry point; verify upstream path/discovery rules in #1 rather than relying on guesses.

The manifest identifies imports/entry points and declarative inputs. Layout contains view-only data (positions, collapsed regions, annotations) and anchors linking supported graphical primitives to source spans or stable AST identities. It must never contain the sole copy of executable logic. Unknown code and user-defined callbacks must survive load/edit/save unchanged.

Published workflows are immutable by **content hash + dependency lock/versions**. Each run pins definition, provider version, inputs and configuration needed to interpret results. Editing creates a new revision; running revisions do not silently switch code.

This is **code-first and graph-aware**, not “generate TypeScript, throw it away, regenerate from React Flow JSON”. Conversely, a completely visual workflow may produce canonical TypeScript with source annotations/anchors for safe later edits.

### Proof fixture

Start with a single fixture containing:
- sequential deterministic task
- conditional branch
- parallel agents/child tasks
- approval/checkpoint
- typed input/output
- custom callback or opaque code region
- dynamically generated child work
- a controlled side effect with idempotency/manual-recovery contract

Prove source/no-op-save invariants independently of whether the graph can statically resolve the dynamic part.

## 4. Target component boundaries

```text
                    Pi command / model-callable tool
                                |
                            Workflow API
                                |
             +------------------+---------------------+
             |                  |                     |
      Workflow library     Web graph editor       Run inspector
      + version store      + code editor          + native task state
             |                  |                     |
             +------ canonical workflow package ------+
                                |
                     validation / capability check
                                |
                     WorkflowRuntime interface
                       /                 \
                 Pi adapter        Pi Durable adapter (default durability)
                                                  |
                                            Native tasks/docs
                                |
                optional registered CodeExecutor boundary
                   /                              \
          trusted local                   Cloudflare Dynamic Workers
```

Cloudflare **Workflows / Dynamic Workflows** (optional, later) would be a *separate* `WorkflowRuntime`. Dynamic Workers are an optional **code execution** provider, not an orchestrator.

Proposed ports (not claims about upstream types):
- `WorkflowRepository`: discover/load/save/publish immutable definitions
- `WorkflowRuntime`: validate/start/status/signal/cancel; explicitly list capabilities
- `CodeExecutor`: run approved, content-addressed code units under a permission/sandbox policy
- Native task correlation: use Pi Durable's taskGraph/watchTaskGraph and getTask; external telemetry sinks live in a separate extension
- `WorkflowProjector`: parse/visualize and **safely** apply only supported edits to source

The regular Pi extension owns `registerCommand` and model tool invocation. The Pi Durable adapter owns its named tasks/conversation invocation and durable state. Don't assume those extension APIs have identical registration or lifecycle contracts.

## 5. Invocation semantics

Target user experiences:
- `/workflow list`
- `/workflow run <name> --input-json '{"ticket":42}'`
- “run X workflow” through a **model-callable** `run_workflow` tool selected by the agent.

All paths resolve the *same* workflow artifact and input schema. An explicit command should not depend on LLM intent parsing. A natural-language request should use tool calling, not an untrusted prompt regex that launches side effects automatically.

The invoker checks: existence, permissions, schema, provider capabilities, effect policy, version/source hash and current run ownership. Return a run ID and provide inspect/cancel operations only if backed by the selected runtime.

## 6. Execution and recovery

- Model each workflow run on Pi Durable as an appropriately scoped native task/task tree where API contracts allow. Use the runtime's storage mechanisms for inputs, outputs, child receipts, checkpoints, and parent/child links.
- Recovery tests must include process/worker termination during an active step, a repeated submission, an approval wait, and an external side effect.
- Distinguish **at-least-once** attempts, durable recorded completions, ambiguous side-effect outcomes, and safe re-execution.
- For dynamic fan-out, the *runtime* task graph is the truth about edges actually created. Static projection shows a dynamic placeholder until observed.
- Keep retries/timeouts/approvals driven by the owning runtime and explicit adapters, not parallel ad hoc process state.
- Validate the limits of conversation-scoped vs globally discoverable storage in #1.

## 7. Editor, native run inspection and security requirements

**Editor (first cut):** load/display arbitrary source package; layout persistence; code pane; supported property edit; refuse edits with ambiguous AST/source mapping. Prefer a small working subset over a wide catalog that discards semantics.

**Source-backed canvas authoring (bounded extension):** an explicitly marked pair of `@pi-workflows:canvas-start` / `@pi-workflows:canvas-end` comments in `runWorkflow(input, ports)` permits drag-in Hook/Agent/Approval statements. These have stable `canvas_*` identities; source statement order is authoritative and solid arrows are derived from it. Handle-to-handle drag **reorders** a linear sequence; it is not generic edge rewiring. Generated statements are canonical and reject unrecognized interior code instead of replacing it. Layout still stores only positions and illustrative edges; no new executable graph format or parallel workflow engine is introduced. Arbitrary branching, callback rewrites and fan-out remain authored in TypeScript. The starter templates use `hook(name,input)`, `agent(name,0)`, and `approve(name)` with denial throwing; the caller must review/adjust port semantics before use.

**Native run inspection:** keep the static authoring graph separate from the live Pi Durable task graph. The workflow builder projects native run ID, revision pins, task ownership and committed status through the read-only contract in [run correlation](run-correlation.md). Full agent/model/tool/hook traces, spans, retention/export and historical timelines belong to a separate telemetry extension. Missing visibility must stay explicitly missing, never guessed.

**Safety/trust:** installing a Pi extension gives it the host process's privileges. Never execute arbitrary imported workflow TypeScript from the browser in the host by default. Require trust approval and scoped permissions; isolate untrusted code (potentially Dynamic Workers), constrain secrets/network/filesystem access, and redact logs/traces. Human approval gates protect side effects, not merely a visible UI prompt.

## 8. Delivery sequence, WIP and stop rules

Keep **one implementation workstream active** through the proof; avoid scaffolding every subsystem at once.

| Sequence | Issue | Evidence required |
|---|---|---|
| 1 | [#1 Upstream feasibility](https://github.com/mhingston/pi-workflows/issues/1) | Source-backed API/guarantee matrix and runnable tiny probes |
| 2 | [#2 Artifact & lossless fixtures](https://github.com/mhingston/pi-workflows/issues/2) | Source/graph round-trip tests on hard fixtures |
| 3 | [#3 Pi Durable execution](https://github.com/mhingston/pi-workflows/issues/3) | Child execution and restart recovery with effect safety |
| 4 | [#4 Regular Pi invocation](https://github.com/mhingston/pi-workflows/issues/4) | Slash command + agent tool operating on same artifact |
| 5 | [#5 Visual editor](https://github.com/mhingston/pi-workflows/issues/5) | No-op import/export and one safe graphical edit |
| **Gate** | [#6 End-to-end slice](https://github.com/mhingston/pi-workflows/issues/6) | Both entry points, Pi Durable recovery, source preservation |

**After the gate:** [#7 provider capabilities and publishing](https://github.com/mhingston/pi-workflows/issues/7), [#8 traces/hooks](https://github.com/mhingston/pi-workflows/issues/8), [#9 optional Cloudflare spike](https://github.com/mhingston/pi-workflows/issues/9).

**Stop/reevaluate if**: the current APIs cannot safely run a trusted canonical source through Pi Durable; the visual edit corrupts unrelated code; recovery repeats unprotected side effects; or shared source needs a fragile/reimplemented orchestration kernel. In that case, keep a single backend and document the incompatibility instead of adding compatibility shims everywhere.

Do **not** call the work “done” after producing an attractive graph; the proving tests are format round-trip and recovered native execution.

## 9. Reference implementations (inspiration, not direct dependencies)

- [Pi coding agent extension API](https://pi.dev/docs/latest/extensions)
- [Pi Durable upstream README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) — **experimental, API subject to change**; pin/check implementation
- [osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows) — graph semantics, lifecycle, checkpoints, idempotency contracts
- [michaelliv/pi-dynamic-workflows](https://github.com/michaelliv/pi-dynamic-workflows) — runtime-generated agent orchestration
- [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Cloudflare Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

Re-check API claims against the versions installed for each implementation PR. No external engine is part of v1 by default.
