# pi-workflows

A code-first workflow workbench for [Pi](https://pi.dev/). Start from trusted TypeScript, inspect its static graph projection, and make safe edits without losing the code the graph cannot represent.

[![Watch the original workflow builder walkthrough (pre-palette UI)](docs/assets/workflow-builder-preview.gif)](docs/assets/workflow-builder-walkthrough.webm)

[Original projection walkthrough](docs/assets/workflow-builder-walkthrough.webm) · [Pre-palette builder overview](docs/assets/workflow-builder-overview.png) · [Source-aware edit example](docs/assets/workflow-builder-safe-edit.png)

## Quick start: open the builder

**You’ll need Node.js 22.19 or newer and npm.** From a terminal:

```sh
git clone https://github.com/mhingston/pi-workflows.git
cd pi-workflows
npm install --ignore-scripts
npm run editor -- --workflow ./fixtures/complex
```

Open **http://localhost:4175** in your browser. The example package is `dynamic_agents`; the editor loads its TypeScript and shows a static projection without starting a workflow. Stop the local server with `Ctrl+C` when you’re done.

## Build steps visually

The example has an explicitly marked **managed canvas region** inside `runWorkflow(input, ports)`. Drag **Hook**, **Agent**, or **Approval** from the palette onto the canvas (or click a palette button to add it). Each creates a real TypeScript statement, not a layout-only decoration. Select a managed step to rename or delete it. Drag its **OUT** handle onto another step's **IN** handle to place the target immediately after the source in the linear execution order; the inspector has a keyboard-friendly equivalent. **Save to disk** persists `workflow.ts`, `workflow.json`, and `layout.json`.

For the initial templates, Hook calls `ports.hook(name, input)`, Agent calls `ports.agent(name, 0)` and discards the return, and Approval denies by throwing on a false result. Check these arguments and semantics in the TypeScript pane before running. Arbitrary conditions, parallelism, loops and freeform branching remain code-only. Without the opt-in markers, the palette is disabled.

## Make a safe first edit

1. Select the **ports.agent (worker)** node in the graph.
2. In **Node properties**, change **Literal name** to `reviewer` and choose **Apply name**.
3. Check that the selected node and `workflow.ts` now show `reviewer`. The header marks the change as **Unsaved changes**.
4. Choose **Save to disk** to keep the edit in the selected workflow directory. Choose **Reload disk** to discard staged edits and restore the files from disk.

Only the recognized string literal is changed by this graph property. The code pane remains available for source edits; the editor validates TypeScript and rejects edits when a source mapping can’t be matched safely.

![The builder with a literal agent name edit staged in memory and reflected in workflow.ts](docs/assets/workflow-builder-safe-edit.png)

## Reading the graph

This is an **n8n-inspired but deliberately limited** authoring canvas, not full n8n graph editing. You can drag managed steps onto the canvas, remove them and reconnect their **linear** order. Moving a node only changes layout. Unmanaged AST nodes remain read-only as structures; a dashed connection is still illustrative rather than executable.

- **Blue call nodes** represent recognized `ports.hook`, `ports.agent`, or `ports.approve` calls. Only a string-literal name on a recognized call is editable as a node property.
- **Branch, parallel, and dynamic nodes** show structures found in the source. Loops, branches, and fan-out are not rewritten through graph operations.
- **Opaque nodes** stand for code the graph does not model. The complete TypeScript stays authoritative in the source pane.
- **Solid arrows connect managed steps** in their exact source execution order. Dragging handles reorders the corresponding TypeScript statements; arbitrary edge rewiring or branch graphs are not supported. **Dashed connections** remain layout hints, not runtime dependencies.
- **The Native execution graph panel** is a separate, read-only view. It needs an embedding process connected to the owning Pi Durable host; the standalone editor does not run or attach to a workflow.

The editor is a local development tool bound to loopback. Loading the builder runs no workflow task, model call, or trusted module. It does not execute arbitrary TypeScript from the browser, and it is not an authenticated hosted service.

## What works today

- A browser graph workbench with drag-to-create Hook/Agent/Approval steps in a marked linear TypeScript region, deletion, renaming and handle-based reorder.
- Source-aware edits for recognized literal call names, editable TypeScript, and layout changes staged until save.
- Regular Pi `/workflow` commands and the `run_workflow` tool as entry points to the same workflow artifact.
- Native Pi Durable integration for the pinned, trusted `dynamic_agents` fixture. Regular Pi invocation is not crash-resumable.

Only trusted registered workflow modules are executable today. The visual editor does not execute arbitrary imported source. See the guides below for the supported runtime behavior and limitations.

## Choose your next step

| If you want to… | Read… |
| --- | --- |
| Understand editor behavior, safe edits, and limits | [Visual editor guide](docs/visual-editor.md) |
| Learn the `workflow.ts` / manifest / layout package | [Artifact format](docs/artifact-format.md) |
| Invoke a workflow from regular Pi | [Regular Pi commands and tool](docs/regular-pi-invocation.md) |
| Understand native tasks, checkpoints, and recovery | [Pi Durable execution](docs/durable-runtime.md) |
| Inspect run IDs and native task hierarchy | [Run correlation](docs/run-correlation.md) |
| Review providers and immutable publishing | [Provider contracts and publishing](docs/provider-publishing.md) |
| Follow the end-to-end evidence and release gate | [Integration gate](docs/integration-gate.md) |

## Verify changes

With dependencies installed, run the relevant checks:

```sh
npm run typecheck
npm run test:artifact
npm run test:durable
npm run test:invocation
npm run test:editor
npm run test:gate
npm run test:correlation
npm run test:providers
```

## Project scope

This project is independent of the similarly named [osolmaz/pi-workflows](https://github.com/osolmaz/pi-workflows). For the architecture and current design decisions, see the [implementation handoff](docs/HANDOFF.md).
