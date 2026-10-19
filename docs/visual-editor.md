# Visual editor v1 — issue #5

## Run

Install dependencies on Node >=22.19, then start the **loopback-only** editor:

~~~sh
npm install --ignore-scripts
npm run editor -- --workflow ./fixtures/complex
~~~

Open http://localhost:4175. A custom directory must contain \`workflow.ts\` and \`workflow.json\`, with optional \`layout.json\`. The loader validates schema version, source SHA-256, and every present layout anchor **before displaying** the package. No workflow task, model call or trusted module is run merely by opening the editor.

The browser workbench shows a draggable source projection, a managed-step palette, node inspector and editable full TypeScript code. The user can add, rename, delete and linearly reconnect supported managed steps, or author one statically validated IF/ELSE branch; those operations rewrite a bounded region of `workflow.ts`, not arbitrary graph JSON. **Save to disk** applies only validated changes to the explicitly selected local directory. **Download files** exposes the current versioned text files individually, preserving exact content. Editing remains staged in memory until saved. Saving an unchanged package is a strict no-op; external filesystem changes cause a conflict rather than a silent overwrite.

## Recognition and safety

The projector uses the TypeScript compiler AST. It currently recognizes \`if\` branches, loops, \`Promise.all\`, and direct \`ports.hook/agent/approve\` calls whose first argument is a **string literal**. Only the string-literal **name** on those exact calls is editable as a node property. It rewrites exactly that AST span, updates manifest/source hashes, remaps anchored layout positions, and revalidates. It never evaluates the source and never converts the graph back into TypeScript. Generated IDs have deterministic, per-construct ordinal names (for example \`ast_hook_1\`); restructuring code may require explicit layout reconciliation in a later version.

Existing arbitrary branching, looping and parallelism are deliberately **not** rewritten graphically. A single opt-in canvas region can author sequential operations: The node list and any existing \`layout.json\` edges are hints, not a runtime task DAG. Dynamic fan-out is shown as a dynamic region; everything else remains visible as authoritative code or an opaque/code placeholder. No invented runtime edges are added. Imported custom layout nodes and illustrative edges are retained even when they are not statically recognized.


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

The markers must be unique, with matching indentation, and only canonical editor-created statements are rewritten. If unexpected code appears inside the region, graphical structural changes fail closed. Rename and delete a managed node from its inspector. Drag its **OUT** handle onto another managed node's **IN** handle (or choose **Place this step after** in the inspector): this reorders the second statement directly after the first, so the solid arrows show true linear source order. This does **not** permit cycles, arbitrary fan-in/fan-out, or rewiring an opaque source block. The legacy dashed edges remain illustrative layout hints. Dragging any existing graph node to a new position changes layout only. Check agent argument values and approval semantics in the TypeScript pane before executing a workflow.

The code pane permits source changes, subject to valid TypeScript syntax and unambiguous source-anchor remapping. If an anchored region cannot be safely matched after editing, the server **rejects** the edit with an error; it never discards annotations or alters unrelated source. Changing an arbitrary code region is a manual source revision (new source hash); immutable publishing and semantic version policy are future work (#7). Unsupported structural graph operations remain unavailable. Managed canvas IDs are preserved through reordering; the editor checks source anchors before writing and rejects overlapping unmanaged anchors.

The editor binds only to 127.0.0.1, requires same-origin JSON writes, selects its workflow directory at server launch, checks editor revision and on-disk file snapshots before save, and runs no arbitrary TypeScript. This is a **local development tool**, not an authenticated multi-user service; do not expose it through cloudflared or reverse proxies. Multi-file saves use staging and best-effort rollback, not a crash-atomic filesystem transaction; source hashes will detect incomplete writes on next load.

## Tests and limits

~~~sh
npm run typecheck
npm run test:editor
~~~

Tests cover branch/parallel/dynamic projections, no-op text round trips, layout edits, source-mapped names, managed step create/rename/delete/reorder with source hashing and local HTTP persistence, code-only opaque logic, stale anchors and unsupported versions. Opening or editing the graph does not execute workflows.

Explicitly out of scope: arbitrary edge rewiring, general graph-to-TypeScript compilation, arbitrary expressions as node properties, live runtime execution graphs, code execution isolation, and running in a hosted browser. The native Pi Durable runtime remains separately responsible for execution and recovery.

## Source-mapped IF/ELSE slice — issue #25

Click or drag **+ IF branch** to insert exactly one managed conditional into the canvas markers. It emits canonical TypeScript with a fixed, typed fixture condition:

~~~ts
// @pi-workflows:branch canvas_a1b2c3d4e5f60708
if (input.requiresApproval) {
  // @pi-workflows:step canvas_1122334455667788
  await ports.hook("true-path", input);
} else {
  // @pi-workflows:step canvas_8877665544332211
  await ports.hook("false-path", input);
}
~~~

The condition is not inferred from an arbitrary expression: the containing workflow must declare `WorkflowInput.requiresApproval: boolean` and use that unshadowed interface for `runWorkflow`'s input parameter. A generic type parameter named `WorkflowInput` disables branch authoring, even if an interface of the same name also exists. The UI offers **TRUE** and **FALSE** output ports; drag either to a managed step's **IN** port to place that statement in the selected arm. For keyboard-only or touch use, select the managed step, choose **TRUE** or **FALSE** in its inspector, and activate **Connect to selected IF arm**. This calls the same source-backed operation. Step **OUT → IN** changes order **only within the same arm**. In the inspector, **Disconnect from branch** moves the step to the top level immediately after the IF. Delete an empty branch only after disconnecting or deleting its steps. A subsequent top-level step is the continuation after both arms. An empty arm connects from its corresponding TRUE/FALSE output straight to that continuation; a populated arm joins from its final step. Solid arrows project possible TypeScript control flow, **not** Pi Durable runtime dependencies; a thrown error or rejection can prevent reaching the next step.

This is deliberately **not** arbitrary structural graph editing: one branch per managed canvas region, one fixed condition, no nested branches, loops, cross-arm direct joins, parallel work, computed conditions, generic data ports, or cycles. These must be authored as TypeScript in the code pane. Unknown code inside a managed region, changed branch condition, stale source anchors, overlapping custom anchors, and unsupported edge rewires are rejected. Unknown TypeScript **outside** the managed region stays byte-for-byte intact. Source and layout identity round-trip without reformatting when no edits occur.

The local editor does not execute source. The branch tests also transpile and invoke the generated **trusted fixture** in isolation with stub ports to prove the conditional semantics; that is **not** a trusted Pi invocation. The existing Pi and Pi Durable invocation adapters deliberately reject edited source revisions unless they match their pinned, registered fixture. Supporting execution of a newly authored package requires an explicit trusted registration/runtime capability slice, not a change to the graph model.
