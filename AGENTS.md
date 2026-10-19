# AGENTS.md — pi-workflows contributor guidance

This repository is bootstrapping a **Pi workflow workbench**. Before writing code, read [docs/HANDOFF.md](docs/HANDOFF.md), then the GitHub issue you are implementing. The handoff is the current design intent; the upstream APIs and feasibility claims still require verification in [#1](https://github.com/mhingston/pi-workflows/issues/1).

## Mission

Deliver the smallest evidence-backed vertical slice: author one reusable workflow in native TypeScript, project it into an n8n-like graph, save without semantic loss, invoke through regular Pi's slash command/model tool, and run it with **native Pi Durable tasks** including recovery.

**Do not** build a parallel durable orchestration engine, assume Pi has a canonical JSON workflow format, or make React Flow's JSON the source of truth. Follow the real upstream APIs, not previous speculative descriptions.

## Working rules

1. **Scope:** work on one GitHub issue at a time; keep a focused PR and cite its issue. Preserve documented invariants. Don't scaffold unrelated features.
2. **Verify first:** inspect pinned upstream Pi and Pi Durable source/types, run a small reproducible spike, and document supported/unsupported/unknown details. Pi Durable is experimental; don't invent API methods or stability guarantees.
3. **Source of truth:** TypeScript workflow source is authoritative. The proposed manifest and visual layout are metadata/projections. No-op saves preserve source; visual edits must not overwrite unknown or dynamic code.
4. **Expressiveness:** keep arbitrary callbacks, loops, dynamic tasks and provider-specific code intact. Unsupported visual structures become explicit opaque/code regions; never silently drop or simplify behavior.
5. **Runtime adapters:** separate regular Pi and Pi Durable integration. Capability-check providers before invocation; reject unsupported features explicitly. Provider portability never implies identical durability.
6. **Effects/replay:** assume an interrupted operation might be reattempted. Use idempotency receipts, explicit human reconciliation or compensating actions for external effects. Don't promise exactly-once semantics.
7. **Code trust:** initially execute trusted, registered modules only. Don't evaluate arbitrary workflow uploads in the host process; sandboxing/Cloudflare Dynamic Workers are future optional work. Do not leak credentials/PII into traces.
8. **Observability:** this repository only owns native workflow identity/task-state projection. A separate extension owns telemetry, spans, hooks, persistence and trace UI. Prefer the existing Pi Durable task APIs; do not add a second event bus or claim hook/model events from fixture no-op hooks. See [run correlation](docs/run-correlation.md).
9. **Maintainability:** prefer typed interfaces, small packages and contract tests. Avoid an abstraction until a second implementation or an explicit capability boundary justifies it.
10. **Testing:** add focused tests reproducing the claimed behavior, including negative/capability tests. For durability claims, demonstrate forced-stop/restart and idempotency behavior with receipts. Report tests actually run and any untested assumptions.
11. **Docs:** update the handoff or relevant ADR when changing the format, provider contract or recovery guarantees. Distinguish implemented behavior from aspirations.
12. **Delivery:** open a PR; report issue links, main changes, test results and known limitations. Don't merge unless explicitly requested.

## Preferred workflow

- Read the relevant issue + handoff; check what already exists.
- State a concrete acceptance test and identify the smallest code slice.
- Implement -> test -> inspect diff for accidental semantic loss -> document.
- In PR, include **Evidence / Risks / Out of scope / Follow-ups**.
- Stop rather than adding compatibility shims when upstream contracts falsify the design; revise the decision with a small experiment.

## First work queue

1. [#1 Upstream API feasibility](https://github.com/mhingston/pi-workflows/issues/1) — begin here.
2. [#2 Lossless artifact contract](https://github.com/mhingston/pi-workflows/issues/2)
3. [#3 Native Pi Durable proof](https://github.com/mhingston/pi-workflows/issues/3)
4. [#4 Pi commands + model tool](https://github.com/mhingston/pi-workflows/issues/4)
5. [#5 Visual graph editor](https://github.com/mhingston/pi-workflows/issues/5)
6. [#6 Cross-runtime vertical slice gate](https://github.com/mhingston/pi-workflows/issues/6)

Later: provider capabilities/immutable publishing (#7), observability (#8), and optional Cloudflare integration (#9). Keep those off the P0 critical path.

## Upstream docs

- https://pi.dev/docs/latest/extensions
- https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- https://github.com/osolmaz/pi-workflows
- https://github.com/michaelliv/pi-dynamic-workflows
