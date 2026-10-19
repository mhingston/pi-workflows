# Workflow artifact format v1 — issue #2

**Status:** code-first storage contract, not a first-party Pi workflow format.
**Implementation:** [src/artifact.ts](../src/artifact.ts) with machine-readable [manifest](../schemas/workflow-manifest.schema.json) and [layout](../schemas/workflow-layout.schema.json) schemas.

## Files

A reusable workflow is a directory containing:

- **workflow.ts** — the authoritative, trusted TypeScript module. Preserve its **exact UTF-8 source bytes**; arbitrary callbacks, branches, loops and dynamic fan-out remain here.
- **workflow.json** — versioned manifest with ID, workflow semver, entrypoint, SHA-256 digest of the source, JSON Schema inputs/outputs, provider capability requirements and pinned dependencies.
- **layout.json** (optional) — versioned, non-executable graph *projection* and UI coordinates. Its source hash must equal the manifest hash. Each node is a known/opaque/dynamic region; edges are **illustrative**, not schedulable control-flow dependencies.

Neither the editor nor runtime should attempt to reconstitute arbitrary executable code from this graph. In particular, dynamic fan-out creates run-specific tasks whose edges are known only in runtime telemetry. We deliberately **do not** invent a first-party Pi workflow JSON DSL.

Manifest example (digest and dependency versions must be computed from the actual package before use):

~~~json
{
  "schemaVersion": 1,
  "id": "issue_review",
  "version": "1.0.0",
  "entrypoint": "workflow.ts",
  "sourceSha256": "<64 lowercase SHA-256 hex characters>",
  "inputSchema": { "type": "object" },
  "outputSchema": { "type": "object" },
  "requiredCapabilities": ["agent", "approval", "dynamic_tasks"],
  "dependencies": { "@earendil-works/pi-durable": "1.3.0" }
}
~~~

## Import, export and edits

Use \`loadWorkflow({ source, manifestJson, layoutJson })\` to **validate only**, returning a \`LoadedWorkflow\`. It does **not** import, compile or execute the TypeScript. \`exportWorkflow(loaded)\` returns the original exact file strings, so a read/display/no-op-save leaves every byte untouched.

The loader rejects unknown/changed schema versions, malformed data, a source hash mismatch, stale layout hash, stale source anchor, duplicate node identifiers, missing endpoint and edges pretending to represent executable control flow. Format v1 rejects unknown metadata properties rather than silently dropping them. The JSON Schemas and TypeScript types describe the file shapes; cross-file source hashes/anchor relationships and duplicate ID checks are enforced in the loader.

The only supported editing operation in #2 is \`moveNode(loaded, id, x, y)\`, which modifies \`layout.json\` alone and revalidates the entire package. Any structural/behavioral graph edit goes through \`refuseStructuralEdit\` with a clear error: an AST-aware source-mapped editor is deferred to [issue #5](https://github.com/mhingston/pi-workflows/issues/5). A **code editor** can update workflow.ts directly, but must then explicitly recompute manifest/source hashes and verify/remap any layout anchors; editing code must never silently erase existing source mappings.

Source anchors store \`start\`/\`end\` as **UTF-16 JavaScript string indices** over decoded \`workflow.ts\`, with SHA-256 of the selected substring's **UTF-8** bytes. Stable node IDs belong to logical authored regions, not to array positions or runtime task IDs. A known node must have a valid anchor. Dynamic/opaque nodes can be placeholders without anchors; their contents must remain in the TypeScript source.

## Versioning and immutability

- \`schemaVersion: 1\` describes the **format**, separate from workflow semver. New major format schemas need explicit migrations; v1 refuses unknown versions instead of coercing them.
- Workflow publications now pin the exact **source bytes**, manifest, resolved dependency versions and executing adapter implementation in a verified content-addressed local store ([issue #7](https://github.com/mhingston/pi-workflows/issues/7)). See [provider publishing](provider-publishing.md). Native runs persist publication, input and configuration fingerprints.
- Saved \`layout.json\` positions do not change execution. If the source changes, stale layout hashes/anchors deliberately force a reconciliation instead of silently replacing executable code.
- Repeated import/export preserves source and metadata byte-for-byte. The source is not normalized/pretty-printed.

## Expressiveness and recovery

Serializing workflow source does **not** serialize live closures, in-flight JS execution, tool responses or external side effects. An executing workflow must checkpoint JSON-compatible state and task identities using the **selected native backend**, such as Pi Durable's \`defineTask\` / \`runtime.commit\` APIs. Replayed phases can repeat effects; add receipts/idempotency, compensations or manual reconciliation. Backends must reject missing capabilities rather than simulating behavior incorrectly.

The fixture [fixtures/complex/workflow.ts](../fixtures/complex/workflow.ts) deliberately includes a hook, conditional, loop, parallel agent calls, dynamic fan-out, an approval gate and arbitrary callback code. [tests/artifact.test.ts](../tests/artifact.test.ts) synthesizes real manifests/layouts with cryptographic source/anchor hashes, proves no-op byte round-tripping and safe layout-only edits, rejects unsafe mutations, and executes the **trusted checked-in fixture** both before and after source preservation to compare outcomes. The artifact loader never executes untrusted source.

## Reproduction

Node >=22.19 required by Pi 1.3.0. From repository root:

~~~sh
npm install --ignore-scripts
npm run typecheck
npm run test:artifact
~~~

This is a **format milestone** only. It does not yet provide a persistent workflow library, Pi extension commands, native durable execution of this fixture, AST editing, an n8n UI, or full runtime semantics equivalence. Those are gated by issues #3–#6.
