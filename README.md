# pi-workflows

A code-first workflow workbench for [Pi](https://pi.dev/) using
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
for native tasks/checkpoints. The source-preserving artifact format and the
trusted dynamic fixture are implemented; visual editing is not yet implemented.

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

## Verification

Requires Node >=22.19.

```sh
npm install --ignore-scripts
npm run typecheck
npm run test:artifact
npm run test:durable
npm run test:invocation
```

This project is independent of the similarly named
[osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows).
