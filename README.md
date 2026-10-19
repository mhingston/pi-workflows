# pi-workflows

A code-first workflow workbench for [Pi](https://pi.dev/) using
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
for native tasks/checkpoints. The source-preserving artifact format and the
trusted dynamic fixture are implemented; a local-only browser graph viewer/editor is implemented for a conservative AST subset.

**Regular Pi invocation (issue #4):** load `src/pi-extension.ts` through Pi's
`--extension` flag and use `/workflow list`,
`/workflow run dynamic_agents --input-json '{"values":[1,2,3],"requiresApproval":false}'`,
or the `run_workflow` tool. See [invocation and safety documentation](docs/regular-pi-invocation.md).

The TypeScript workflow source remains authoritative: visual editing must never
discard or change unsupported code. Regular Pi is a command/tool entry point,
**not** a crash-resumable runtime. Only the pinned, trusted `dynamic_agents`
fixture is executable today.

See [architecture handoff](docs/HANDOFF.md), [artifact contract](docs/artifact-format.md),
[native durable execution](docs/durable-runtime.md), and [AGENTS.md](AGENTS.md).

**Browser editor (issue #5):** run `npm run editor -- --workflow ./fixtures/complex` and open `http://localhost:4175`. Drag nodes, inspect/edit known literal call names, or edit arbitrary source in the code pane; save only after validation. Unknown code is never reconstructed from the graph. See [editor safety and limitations](docs/visual-editor.md).

**Integration gate (issue #6):** one version-pinned source package is projected and no-op saved in the editor, invoked via both Pi entry points, then verified against native Pi Durable records and restart/ambiguous-effect tests. See [reproducible integration demo, evidence and GO/NO-GO](docs/integration-gate.md).

## Verification

Requires Node >=22.19.

```sh
npm install --ignore-scripts
npm run typecheck
npm run test:artifact
npm run test:durable
npm run test:invocation
npm run test:editor
npm run test:gate
```

This project is independent of the similarly named
[osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows).
