# pi-workflows

A planned visual workflow workbench for [Pi](https://pi.dev/) and [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

**Status:** design/feasibility. No runtime or editor has been implemented.

The goal is to author reusable workflows in code or through an n8n-style visual editor, invoke them from Pi, and execute them through capability-checked runtime providers. Pi Durable is the default intended durable backend. The workflow source remains authoritative: visual editing must never discard or silently change unsupported code.

See the architecture handoff in [docs/HANDOFF.md](docs/HANDOFF.md) and [AGENTS.md](AGENTS.md) for contributor guidance once the documentation PR lands.

## Initial proof

Prove one workflow can be loaded, visualised, saved without semantic loss, invoked from regular Pi and executed through native Pi Durable tasks. Validate durability and side-effect recovery before expanding the node catalog.

## Inspirations and references

- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows) — graph DSL and workflow semantics
- [michaelliv/pi-dynamic-workflows](https://github.com/michaelliv/pi-dynamic-workflows) — dynamic agent orchestration

This project is independent of the similarly named `osolmaz/pi-workflows`.
