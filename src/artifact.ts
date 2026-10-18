/**
 * Portable workflow artifacts: metadata, lossless source, optional visual hints.
 * This module deliberately NEVER imports or executes the workflow source.
 *
 * All source-anchor offsets are JavaScript UTF-16 string indices; hashes
 * always cover UTF-8 encoded text. These representations must not be confused.
 */
export type JsonSchema = Record<string, unknown>;

export interface WorkflowManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entrypoint: "workflow.ts";
  readonly sourceSha256: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly requiredCapabilities: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface SourceAnchor {
  readonly start: number;
  readonly end: number;
  readonly sha256: string;
}

export interface ProjectionNode {
  readonly id: string;
  readonly kind: "known" | "opaque" | "dynamic";
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly anchor?: SourceAnchor;
}

export interface ProjectionEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** This is an authoring hint, NEVER an executable control-flow edge. */
  readonly kind: "illustrative";
}

export interface WorkflowLayout {
  readonly schemaVersion: 1;
  readonly sourceSha256: string;
  readonly nodes: readonly ProjectionNode[];
  readonly edges: readonly ProjectionEdge[];
}

export interface WorkflowFiles {
  readonly source: string;
  readonly manifestJson: string;
  readonly layoutJson?: string;
}

export interface LoadedWorkflow {
  readonly source: string;
  readonly manifest: WorkflowManifest;
  readonly layout?: WorkflowLayout;
  /** Raw strings retained to make unedited import/export byte-for-byte lossless. */
  readonly files: WorkflowFiles;
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

function fail(message: string): never {
  throw new ArtifactError(message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path + " must be an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(path + " contains unsupported property: " + key);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path + " must be a nonempty string");
  return value;
}

const ID = /^[a-z][a-z0-9_-]*$/;
const SHA = /^[a-f0-9]{64}$/;
/** SemVer 2.0 (strict core numerics, prerelease identifiers, optional build metadata). */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function checkId(value: unknown, path: string): string {
  const id = string(value, path);
  if (id.length > 128 || !ID.test(id)) fail(path + " must be a stable lower-case identifier");
  return id;
}

function checkSha(value: unknown, path: string): string {
  const sha = string(value, path);
  if (!SHA.test(sha)) fail(path + " must be a lowercase SHA-256 hex digest");
  return sha;
}

function checkVersion(value: unknown, path: string): string {
  const version = string(value, path);
  if (!VERSION.test(version)) fail(path + " must be a semver version");
  return version;
}

function schema(value: unknown, path: string): JsonSchema {
  return record(value, path);
}

function checkManifest(value: unknown): WorkflowManifest {
  const v = record(value, "manifest");
  onlyKeys(v, [
    "schemaVersion", "id", "version", "entrypoint", "sourceSha256",
    "inputSchema", "outputSchema", "requiredCapabilities", "dependencies",
  ], "manifest");
  if (v.schemaVersion !== 1) fail("unsupported manifest schemaVersion (expected 1)");
  checkId(v.id, "manifest.id");
  checkVersion(v.version, "manifest.version");
  if (v.entrypoint !== "workflow.ts") fail("manifest.entrypoint must be workflow.ts");
  checkSha(v.sourceSha256, "manifest.sourceSha256");
  schema(v.inputSchema, "manifest.inputSchema");
  schema(v.outputSchema, "manifest.outputSchema");
  if (!Array.isArray(v.requiredCapabilities)) {
    fail("manifest.requiredCapabilities must be an array");
  }
  const caps = v.requiredCapabilities as unknown[];
  for (const [i, cap] of caps.entries()) {
    checkId(cap, "manifest.requiredCapabilities[" + i + "]");
  }
  if (new Set(caps).size !== caps.length) fail("duplicate required capability");
  const dependencies = record(v.dependencies, "manifest.dependencies");
  for (const [name, version] of Object.entries(dependencies)) {
    string(name, "dependency name");
    string(version, "manifest.dependencies." + name);
  }
  return v as unknown as WorkflowManifest;
}

function numeric(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path + " must be finite");
  return value;
}

function checkLayout(value: unknown, source: string): Promise<WorkflowLayout> {
  return (async () => {
    const v = record(value, "layout");
    onlyKeys(v, ["schemaVersion", "sourceSha256", "nodes", "edges"], "layout");
    if (v.schemaVersion !== 1) fail("unsupported layout schemaVersion (expected 1)");
    const hash = checkSha(v.sourceSha256, "layout.sourceSha256");
    if (hash !== await sha256(source)) fail("layout is stale for this workflow source");
    if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) {
      fail("layout.nodes and layout.edges must be arrays");
    }
    const ids = new Set<string>();
    for (const [i, n] of (v.nodes as unknown[]).entries()) {
      const path = "layout.nodes[" + i + "]";
      const node = record(n, path);
      onlyKeys(node, ["id", "kind", "label", "x", "y", "anchor"], path);
      const id = checkId(node.id, path + ".id");
      if (ids.has(id)) fail("duplicate node ID: " + id);
      ids.add(id);
      if (typeof node.kind !== "string" || !["known", "opaque", "dynamic"].includes(node.kind)) {
        fail(path + ".kind must be known, opaque or dynamic");
      }
      string(node.label, path + ".label");
      numeric(node.x, path + ".x");
      numeric(node.y, path + ".y");
      if (node.kind === "known" && node.anchor === undefined) {
        fail("known node requires an anchored source region");
      }
      if (node.anchor !== undefined) {
        const anchor = record(node.anchor, path + ".anchor");
        onlyKeys(anchor, ["start", "end", "sha256"], path + ".anchor");
        const start = anchor.start;
        const end = anchor.end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            (start as number) < 0 || (end as number) <= (start as number) ||
            (end as number) > source.length) fail(path + ".anchor has invalid UTF-16 offsets");
        const digest = checkSha(anchor.sha256, path + ".anchor.sha256");
        const actual = await sha256(source.slice(start as number, end as number));
        if (digest !== actual) fail(path + ".anchor is stale or corrupt");
      }
    }
    const edgeIds = new Set<string>();
    for (const [i, e] of (v.edges as unknown[]).entries()) {
      const path = "layout.edges[" + i + "]";
      const edge = record(e, path);
      onlyKeys(edge, ["id", "from", "to", "kind"], path);
      const id = checkId(edge.id, path + ".id");
      if (edgeIds.has(id)) fail("duplicate edge ID: " + id);
      edgeIds.add(id);
      if (!ids.has(string(edge.from, path + ".from")) ||
          !ids.has(string(edge.to, path + ".to"))) fail(path + " references a missing node");
      if (edge.kind !== "illustrative") {
        fail(path + " must be illustrative (not executable control flow)");
      }
    }
    return v as unknown as WorkflowLayout;
  })();
}

/** Hash UTF-8 source bytes; works in Node >=22 and browsers/Workers with Web Crypto. */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function parseJson(input: string, path: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    fail(path + " contains invalid JSON");
  }
}

/** Validates metadata and hashes, but never imports, evaluates or executes TS. */
export async function loadWorkflow(files: WorkflowFiles): Promise<LoadedWorkflow> {
  if (typeof files.source !== "string" || typeof files.manifestJson !== "string" ||
      (files.layoutJson !== undefined && typeof files.layoutJson !== "string")) {
    fail("workflow files must be UTF-8 strings");
  }
  const manifest = checkManifest(parseJson(files.manifestJson, "workflow.json"));
  if (await sha256(files.source) !== manifest.sourceSha256) {
    fail("workflow.ts checksum does not match workflow.json; explicit republish required");
  }
  const layout = files.layoutJson === undefined
    ? undefined
    : await checkLayout(parseJson(files.layoutJson, "layout.json"), files.source);
  return { source: files.source, manifest, layout, files: { ...files } };
}

/** No-op saves preserve all file strings exactly, including source whitespace. */
export function exportWorkflow(artifact: LoadedWorkflow): WorkflowFiles {
  return { ...artifact.files };
}

/** Only cosmetic positions are editable until the AST-aware editor (#5). */
export async function moveNode(
  artifact: LoadedWorkflow, id: string, x: number, y: number,
): Promise<LoadedWorkflow> {
  if (artifact.layout === undefined) fail("workflow has no visual layout");
  numeric(x, "position.x");
  numeric(y, "position.y");
  if (!artifact.layout.nodes.some(n => n.id === id)) fail("unknown node: " + id);
  const layout: WorkflowLayout = {
    ...artifact.layout,
    nodes: artifact.layout.nodes.map(n => n.id === id ? { ...n, x, y } : n),
  };
  return loadWorkflow({
    ...artifact.files,
    layoutJson: JSON.stringify(layout, null, 2) + "\n",
  });
}

/** Refuse structural/behavioral edits until a source-mapped AST transform exists. */
export function refuseStructuralEdit(_artifact: LoadedWorkflow, _edit: unknown): never {
  fail("unsafe visual edit: use the source editor; source-mapped rewriting is not implemented");
}

/** Pin run provenance without assuming the chosen runtime implements the capability. */
export interface WorkflowRunProvenance {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly sourceSha256: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly runtime: { readonly id: string; readonly version: string };
  readonly configurationSha256: string;
  readonly inputSha256: string;
}
