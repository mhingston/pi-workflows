# Visual editor v1 — issue #5

## Run

Install dependencies on Node >=22.19, then start the **loopback-only** editor:

~~~sh
npm install --ignore-scripts
npm run editor -- --workflow ./fixtures/complex
~~~

Open http://localhost:4175. A custom directory must contain \`workflow.ts\` and \`workflow.json\`, with optional \`layout.json\`. The loader validates schema version, source SHA-256, and every present layout anchor **before displaying** the package. No workflow task, model call or trusted module is run merely by opening the editor.

The browser workbench shows a draggable static graph projection, node inspector and editable full TypeScript code. **Save to disk** applies only validated changes to the explicitly selected local directory. **Download files** exposes the current versioned text files individually, preserving exact content. Editing remains staged in memory until saved. Saving an unchanged package is a strict no-op; external filesystem changes cause a conflict rather than a silent overwrite.

## Recognition and safety

The projector uses the TypeScript compiler AST. It currently recognizes \`if\` branches, loops, \`Promise.all\`, and direct \`ports.hook/agent/approve\` calls whose first argument is a **string literal**. Only the string-literal **name** on those exact calls is editable as a node property. It rewrites exactly that AST span, updates manifest/source hashes, remaps anchored layout positions, and revalidates. It never evaluates the source and never converts the graph back into TypeScript. Generated IDs have deterministic, per-construct ordinal names (for example \`ast_hook_1\`); restructuring code may require explicit layout reconciliation in a later version.

Branching, looping and parallelism are deliberately **not** rewritten graphically. The node list and any existing \`layout.json\` edges are hints, not a runtime task DAG. Dynamic fan-out is shown as a dynamic region; everything else remains visible as authoritative code or an opaque/code placeholder. No invented runtime edges are added. Imported custom layout nodes and illustrative edges are retained even when they are not statically recognized.

The code pane permits source changes, subject to valid TypeScript syntax and unambiguous source-anchor remapping. If an anchored region cannot be safely matched after editing, the server **rejects** the edit with an error; it never discards annotations or alters unrelated source. Changing an arbitrary code region is a manual source revision (new source hash); immutable publishing and semantic version policy are future work (#7). Unsupported structural graph operations remain unavailable.

The editor binds only to 127.0.0.1, requires same-origin JSON writes, selects its workflow directory at server launch, checks editor revision and on-disk file snapshots before save, and runs no arbitrary TypeScript. This is a **local development tool**, not an authenticated multi-user service; do not expose it through cloudflared or reverse proxies. Multi-file saves use staging and best-effort rollback, not a crash-atomic filesystem transaction; source hashes will detect incomplete writes on next load.

## Tests and limits

~~~sh
npm run typecheck
npm run test:editor
~~~

Tests cover branch/parallel/dynamic projections, no-op text round trips, cosmetic layout edits, a source-mapped name edit, code-only opaque logic, stale anchors and unsupported versions, plus loading and saving via the local HTTP UI without executing a workflow.

Explicitly out of scope: arbitrary edge rewiring, generating source from React Flow state, arbitrary expressions as node properties, live runtime execution graphs, code execution isolation, and running in a hosted browser. The native Pi Durable runtime remains separately responsible for execution and recovery.
