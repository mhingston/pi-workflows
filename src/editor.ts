/**
 * A deliberately conservative TypeScript -> visual projection.
 * Graph nodes are authoring hints. Neither this module nor the UI evaluates TS.
 */
import ts from "typescript";
import { canvasOrder, readCanvas, type CanvasKind } from "./canvas.ts";
import {
  ArtifactError, loadWorkflow, sha256, type LoadedWorkflow, type ProjectionNode,
  type SourceAnchor, type WorkflowLayout,
} from "./artifact.ts";

export type EditorCategory = "branch" | "parallel" | "dynamic" | "call" | "opaque" | "canvas";
export interface EditorNode extends ProjectionNode {
  readonly category: EditorCategory;
  readonly editable?: { readonly field: "name"; readonly value: string };
  readonly canvasKind?: CanvasKind;
}
export interface EditorGraph {
  readonly nodes: readonly EditorNode[];
  readonly edges: WorkflowLayout["edges"];
  readonly notice: string;
  readonly sequenceEdges: ReturnType<typeof canvasOrder>;
  readonly canvasEnabled: boolean;
}
interface Candidate {
  id: string;
  category: EditorCategory;
  kind: ProjectionNode["kind"];
  label: string;
  start: number;
  end: number;
  argument?: { start: number; end: number; value: string };
}
const NOTICE = "Solid arrows denote the exact sequential order in an explicitly managed canvas region. Dashed edges are illustrative layout hints only. Other TypeScript remains authoritative.";

function fail(message: string): never { throw new ArtifactError("editor: " + message); }

function parse(source: string): ts.SourceFile {
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) {
    const error = diagnostics[0]!;
    const where = file.getLineAndCharacterOfPosition(error.start ?? 0);
    fail("invalid TypeScript at " + (where.line + 1) + ":" + (where.character + 1) +
      ": " + ts.flattenDiagnosticMessageText(error.messageText, " "));
  }
  return file;
}

/** An intentionally small, statically recognisable subset; no inferred runtime task edges. */
function candidates(source: string): Candidate[] {
  const file = parse(source);
  const managed = readCanvas(source);
  const found: Candidate[] = [];
  const counts = new Map<string, number>();
  function add(node: ts.Node, category: EditorCategory, kind: ProjectionNode["kind"],
               label: string, prefix: string, argument?: Candidate["argument"]): void {
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    found.push({
      id: "ast_" + prefix + "_" + count, category, kind, label,
      start: node.getStart(file), end: node.end, argument,
    });
  }
  function visit(node: ts.Node): void {
    if (managed && node.getStart(file) >= managed.start && node.end <= managed.end) return;
    if (ts.isIfStatement(node)) add(node, "branch", "known", "Branch (if)", "branch");
    if (ts.isForStatement(node) || ts.isForOfStatement(node) ||
        ts.isForInStatement(node) || ts.isWhileStatement(node) ||
        ts.isDoStatement(node)) {
      add(node, "dynamic", "dynamic", "Loop / dynamic region", "loop");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(receiver) && receiver.text === "Promise" && method === "all") {
        add(node, "parallel", "known", "Parallel region (Promise.all)", "parallel");
      }
      if (ts.isIdentifier(receiver) && receiver.text === "ports" &&
          (method === "hook" || method === "agent" || method === "approve")) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          add(node, "call", "known", "ports." + method + " (" + arg.text + ")",
            method, { start: arg.getStart(file), end: arg.end, value: arg.text });
        }
        // Computed names and nonliteral arguments stay in the code pane.
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

async function anchor(source: string, start: number, end: number): Promise<SourceAnchor> {
  return { start, end, sha256: await sha256(source.slice(start, end)) };
}

/** Import validated files only; preserve pre-existing layout nodes, including unknown anchors. */
export async function projectWorkflow(workflow: LoadedWorkflow): Promise<EditorGraph> {
  const canvas = readCanvas(workflow.source);
  const parsed = candidates(workflow.source);
  const positions = new Map(workflow.layout?.nodes.map(node => [node.id, node]) ?? []);
  const nodes: EditorNode[] = [];
  for (const [index, item] of parsed.entries()) {
    const previous = positions.get(item.id);
    const actual = await anchor(workflow.source, item.start, item.end);
    if (previous && (previous.kind !== item.kind ||
        (previous.anchor && (previous.anchor.start !== actual.start ||
          previous.anchor.end !== actual.end || previous.anchor.sha256 !== actual.sha256)))) {
      fail("layout node " + item.id + " no longer matches its AST span; reconcile in code");
    }
    nodes.push({
      id: item.id, category: item.category, kind: item.kind, label: item.label,
      x: previous?.x ?? 60 + (index % 3) * 290,
      y: previous?.y ?? 60 + Math.floor(index / 3) * 150,
      anchor: actual,
      ...(item.argument ? { editable: { field: "name" as const, value: item.argument.value } } : {}),
    });
    positions.delete(item.id);
  }
  for (const [index, step] of (canvas?.steps ?? []).entries()) {
    const previous = positions.get(step.id);
    const actual = await anchor(workflow.source, step.start, step.end);
    if (previous && (previous.kind !== "known" ||
        !previous.anchor || previous.anchor.start !== actual.start ||
        previous.anchor.end !== actual.end || previous.anchor.sha256 !== actual.sha256)) {
      fail("managed step " + step.id + " layout anchor is stale; reconcile source");
    }
    nodes.push({
      id: step.id, category: "canvas", kind: "known",
      canvasKind: step.type, label: "ports." + step.type + " (" + step.name + ")",
      x: previous?.x ?? 70 + index * 280, y: previous?.y ?? 80,
      anchor: actual, editable: { field: "name", value: step.name },
    });
    positions.delete(step.id);
  }
  for (const other of positions.values()) {
    if (other.id.startsWith("ast_")) fail("layout contains orphaned AST node " + other.id + "; reconcile layout explicitly");
    nodes.push({ ...other, category: other.kind === "dynamic" ? "dynamic" : "opaque" });
  }
  if (!nodes.some(n => n.kind === "opaque")) {
    nodes.push({
      id: "opaque_source", kind: "opaque", category: "opaque",
      label: "Other TypeScript — use code pane", x: 60, y: 60 + Math.ceil(nodes.length / 3) * 150,
    });
  }
  return { nodes, edges: workflow.layout?.edges ?? [], sequenceEdges: canvasOrder(workflow.source),
    canvasEnabled: Boolean(canvas), notice: NOTICE };
}

/** Dragging may create layout.json, but never changes or reconstructs source. */
export async function moveProjectedNode(workflow: LoadedWorkflow, id: string, x: number, y: number): Promise<LoadedWorkflow> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail("node coordinates must be finite");
  const projection = await projectWorkflow(workflow);
  const selected = projection.nodes.find(node => node.id === id);
  if (!selected) fail("unknown node: " + id);
  if (selected.x === x && selected.y === y) return workflow;
  const layout: WorkflowLayout = {
    schemaVersion: 1, sourceSha256: workflow.manifest.sourceSha256,
    nodes: projection.nodes.map(({ id: nid, kind, label, x: nx, y: ny, anchor: a }) =>
      ({ id: nid, kind, label, x: nid === id ? x : nx, y: nid === id ? y : ny, ...(a ? { anchor: a } : {}) })),
    edges: projection.edges,
  };
  return loadWorkflow({
    ...workflow.files, layoutJson: JSON.stringify(layout, null, 2) + "\n",
  });
}

async function remapLiteralAnchors(workflow: LoadedWorkflow, nextSource: string, start: number, end: number) {
  if (!workflow.layout) return undefined;
  const delta = nextSource.length - workflow.source.length;
  const nodes = [];
  for (const node of workflow.layout.nodes) {
    if (!node.anchor) { nodes.push(node); continue; }
    const old = node.anchor;
    let a = old.start, b = old.end;
    if (b <= start) { /* unchanged */ }
    else if (a >= end) { a += delta; b += delta; }
    else if (a <= start && b >= end) { b += delta; }
    else fail("edit partly overlaps anchor " + node.id + "; edit source manually");
    nodes.push({ ...node, anchor: await anchor(nextSource, a, b) });
  }
  return { ...workflow.layout, sourceSha256: await sha256(nextSource), nodes };
}

async function updated(workflow: LoadedWorkflow, source: string, layout?: WorkflowLayout): Promise<LoadedWorkflow> {
  if (source === workflow.source) return workflow;
  parse(source);
  const hash = await sha256(source);
  const manifestJson = JSON.stringify({ ...workflow.manifest, sourceSha256: hash }, null, 2) + "\n";
  const layoutJson = layout ? JSON.stringify({ ...layout, sourceSha256: hash }, null, 2) + "\n" : undefined;
  return loadWorkflow({ source, manifestJson, ...(layoutJson ? { layoutJson } : {}) });
}

/** Rewrite only an AST-verified string-literal argument of ports.hook/agent/approve. */
export async function editKnownName(workflow: LoadedWorkflow, id: string, value: string): Promise<LoadedWorkflow> {
  if (typeof value !== "string" || value.length > 500) fail("name must be a string of at most 500 characters");
  const item = candidates(workflow.source).find(candidate => candidate.id === id);
  if (!item?.argument) fail("node " + id + " has no safely editable literal name");
  if (value === item.argument.value) return workflow;
  const { start, end } = item.argument;
  const old = workflow.source.slice(start, end);
  if (!/^(['"])/.test(old) || old[old.length - 1] !== old[0]) fail("unsupported literal encoding");
  // JSON encodes quotes, backslashes, control characters and line breaks safely.
  const literal = old[0] === '"' ? JSON.stringify(value) :
    "'" + JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
  const source = workflow.source.slice(0, start) + literal + workflow.source.slice(end);
  const layout = await remapLiteralAnchors(workflow, source, start, end);
  return updated(workflow, source, layout);
}

/**
 * Code edits preserve existing anchors only when each anchored substring is
 * still uniquely identifiable. Ambiguous/modified anchors require a separate
 * explicit source/layout reconciliation; they are NEVER silently discarded.
 */
export async function editCode(workflow: LoadedWorkflow, source: string): Promise<LoadedWorkflow> {
  if (typeof source !== "string") fail("workflow.ts must be text");
  if (source === workflow.source) return workflow;
  parse(source);
  if (!workflow.layout) return updated(workflow, source);
  // A single contiguous changed range can be mapped exactly. A broad rewrite
  // that partly overlaps anchors is deliberately rejected, never guessed.
  let prefix = 0;
  while (prefix < workflow.source.length && prefix < source.length &&
         workflow.source[prefix] === source[prefix]) prefix++;
  let suffix = 0;
  while (suffix < workflow.source.length - prefix && suffix < source.length - prefix &&
         workflow.source[workflow.source.length - 1 - suffix] === source[source.length - 1 - suffix]) suffix++;
  const oldEnd = workflow.source.length - suffix;
  const delta = source.length - workflow.source.length;
  const nodes = [];
  for (const node of workflow.layout.nodes) {
    if (!node.anchor) { nodes.push(node); continue; }
    const old = node.anchor;
    let a = old.start, b = old.end;
    if (b <= prefix) { /* preceding anchor unchanged */ }
    else if (a >= oldEnd) { a += delta; b += delta; }
    else if (a <= prefix && b >= oldEnd) { b += delta; }
    else {
      // An unchanged anchor may have moved as a whole; only a unique match is safe.
      const snippet = workflow.source.slice(a, b);
      const match = source.indexOf(snippet);
      if (match < 0 || match !== source.lastIndexOf(snippet)) {
        fail("cannot safely remap anchor " + node.id + "; separate/reconcile this code edit");
      }
      a = match;
      b = match + snippet.length;
    }
    nodes.push({ ...node, anchor: await anchor(source, a, b) });
  }
  return updated(workflow, source, { ...workflow.layout, nodes });
}
