# Visual editor v1 — issue #5

## Run

Install dependencies on Node >=22.19, then start the **loopback-only** editor:

~~~sh
npm install --ignore-scripts
npm run editor -- --workflow ./fixtures/complex
~~~

Open http://localhost:4175. A custom directory must contain \`workflow.ts\` and \`workflow.json\`, with optional \`layout.json\`. The loader validates schema version, source SHA-256, and every present layout anchor **before displaying** the package. No workflow task, model call or trusted module is run merely by opening the editor.

The browser workbench shows a draggable source projection, a managed-step palette, node inspector and editable full TypeScript code. The user can add, rename, delete and linearly reconnect supported managed steps; those operations rewrite a bounded region of `workflow.ts`, not arbitrary graph JSON. **Save to disk** applies only validated changes to the explicitly selected local directory. **Download files** exposes the current versioned text files individually, preserving exact content. Editing remains staged in memory until saved. Saving an unchanged package is a strict no-op; external filesystem changes cause a conflict rather than a silent overwrite.

## Recognition and safety

The projector uses the TypeScript compiler AST. It currently recognizes \`if\` branches, loops, \`Promise.all\`, and direct \`ports.hook/agent/approve\` calls whose first argument is a **string literal**. Only the string-literal **name** on those exact calls is editable as a node property. It rewrites exactly that AST span, updates manifest/source hashes, remaps anchored layout positions, and revalidates. It never evaluates the source and never converts the graph back into TypeScript. Generated IDs have deterministic, per-construct ordinal names (for example \`ast_hook_1\`); restructuring code may require explicit layout reconciliation in a later version.

Branching, looping and parallelism are deliberately **not** rewritten graphically. A single opt-in canvas region can author sequential operations: The node list and any existing \`layout.json\` edges are hints, not a runtime task DAG. Dynamic fan-out is shown as a dynamic region; everything else remains visible as authoritative code or an opaque/code placeholder. No invented runtime edges are added. Imported custom layout nodes and illustrative edges are retained even when they are not statically recognized.


~~~ts
export async function runWorkflow(input: WorkflowInput, ports: WorkflowPorts) {
  // @pi-workflows:canvas-start
  // @pi-workflows:canvas-end
  // Other TypeScript remains completely untouched.
}
~~~

Drag **+ Hook**, **+ Agent**, or **+ Approval** from the palette onto the graph to create a source statement between those markers. Supported statement templates are:

- Hook: `await ports.hook("name", input);`
- Agent: `await ports.agent("name", 0);` (its numeric result is intentionally unused)
- Approval: `if (!await ports.approve("name")) throw new Error("approval denied");`

The markers must be unique, with matching indentation, and only canonical editor-created statements are rewritten. If unexpected code appears inside the region, graphical structural changes fail closed. Rename and delete a managed node from its inspector. Drag its **OUT** handle onto another managed node's **IN** handle (or choose **Place this step after** in the inspector): this reorders the second statement directly after the first, so the solid arrows show true linear source order. This does **not** provide n8n-style arbitrary cycles, branch connections, or fan-in/fan-out. The legacy dashed edges remain illustrative layout hints. Dragging any existing graph node to a new position changes layout only. Check agent argument values and approval semantics in the TypeScript pane before executing a workflow.

The code pane permits source changes, subject to valid TypeScript syntax and unambiguous source-anchor remapping. If an anchored region cannot be safely matched after editing, the server **rejects** the edit with an error; it never discards annotations or alters unrelated source. Changing an arbitrary code region is a manual source revision (new source hash); immutable publishing and semantic version policy are future work (#7). Unsupported structural graph operations remain unavailable. Managed canvas IDs are preserved through reordering; the editor checks source anchors before writing and rejects overlapping unmanaged anchors.

The editor binds only to 127.0.0.1, requires same-origin JSON writes, selects its workflow directory at server launch, checks editor revision and on-disk file snapshots before save, and runs no arbitrary TypeScript. This is a **local development tool**, not an authenticated multi-user service; do not expose it through cloudflared or reverse proxies. Multi-file saves use staging and best-effort rollback, not a crash-atomic filesystem transaction; source hashes will detect incomplete writes on next load.

## Tests and limits

~~~sh
npm run typecheck
npm run test:editor
~~~

Tests cover branch/parallel/dynamic projections, no-op text round trips, layout edits, source-mapped names, managed step create/rename/delete/reorder with source hashing and local HTTP persistence, code-only opaque logic, stale anchors and unsupported versions. Opening or editing the graph does not execute workflows.

Explicitly out of scope: arbitrary edge rewiring, general graph-to-TypeScript compilation, arbitrary expressions as node properties, live runtime execution graphs, code execution isolation, and running in a hosted browser. The native Pi Durable runtime remains separately responsible for execution and recovery.
