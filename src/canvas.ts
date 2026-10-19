/** Source-first managed canvas: sequential steps and one canonical if/else. */
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { ArtifactError, loadWorkflow, sha256, type LoadedWorkflow, type WorkflowLayout } from "./artifact.ts";

export type CanvasKind = "hook" | "agent" | "approval";
export type CanvasLane = "top" | "then" | "else";
export interface CanvasStep { id: string; type: CanvasKind; name: string; lane: CanvasLane; start: number; end: number }
export interface CanvasBranch { id: string; type: "branch"; start: number; end: number; then: CanvasStep[]; else: CanvasStep[] }
export type CanvasItem = CanvasStep | CanvasBranch;
export interface CanvasRegion {
  start: number; end: number; indent: string; eol: string;
  items: CanvasItem[]; steps: CanvasStep[]; branch: CanvasBranch | null;
}
export type CanvasOperation =
  | { type: "add-step"; kind: CanvasKind; name: string; x: number; y: number }
  | { type: "remove-step"; id: string }
  | { type: "rename-step"; id: string; name: string }
  | { type: "connect-step"; from: string; to: string }
  | { type: "add-branch"; x: number; y: number }
  | { type: "remove-branch"; id: string }
  | { type: "connect-branch"; from: string; to: string; arm: "then" | "else" }
  | { type: "disconnect-branch"; id: string };

const BEGIN = /^([ \t]*)\/\/ @pi-workflows:canvas-start[ \t]*\r?\n/gm;
const FINISH = /^([ \t]*)\/\/ @pi-workflows:canvas-end[ \t]*(?:\r?\n|$)/gm;
const ID = "canvas_[a-f0-9]{16}";
function fail(message: string): never { throw new ArtifactError("canvas: " + message); }
function validateName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 500) fail("step name must be 1–500 characters");
}
function position(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) fail("invalid canvas coordinates");
}
function newId() { return "canvas_" + randomUUID().replace(/-/g, "").slice(0, 16); }
function escapeRegex(v: string) { return v.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"); }
function statement(type: CanvasKind, name: string): string {
  const arg = JSON.stringify(name);
  switch (type) {
    case "hook": return "await ports.hook(" + arg + ", input);";
    case "agent": return "await ports.agent(" + arg + ", 0);";
    case "approval": return "if (!await ports.approve(" + arg + ")) throw new Error(\"approval denied\");";
  }
}
function encodedStep(s: CanvasStep, indent: string, eol: string): string {
  return indent + "// @pi-workflows:step " + s.id + eol + indent + statement(s.type, s.name) + eol;
}
function encodedItem(item: CanvasItem, indent: string, eol: string): string {
  if (item.type !== "branch") return encodedStep(item, indent, eol);
  return indent + "// @pi-workflows:branch " + item.id + eol +
    indent + "if (input.requiresApproval) {" + eol +
    item.then.map(step => encodedStep(step, indent + "  ", eol)).join("") +
    indent + "} else {" + eol +
    item.else.map(step => encodedStep(step, indent + "  ", eol)).join("") +
    indent + "}" + eol;
}
/** Reject markers inside nested statements, unreachable code, invalid syntax or a different scope. */
function supportedScope(source: string, start: number, end: number): boolean {
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (((file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length) return false;
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runWorkflow" &&
        node.body && node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) &&
        node.parameters.length >= 2 && ts.isIdentifier(node.parameters[0]!.name) &&
        node.parameters[0]!.name.text === "input" && ts.isIdentifier(node.parameters[1]!.name) &&
        node.parameters[1]!.name.text === "ports") {
      const body = node.body;
      const inside = start > body.getStart(file) && end < body.end;
      const crosses = body.statements.some(s => {
        const a = s.getStart(file), b = s.end;
        return (a < start && b > start) || (a < end && b > end);
      });
      const returned = body.statements.some(s => ts.isReturnStatement(s) && s.getStart(file) < start);
      if (inside && !crosses && !returned) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}
function comments(source: string): Set<number> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const offsets = new Set<number>();
  let token: ts.SyntaxKind;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken)
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) offsets.add(scanner.getTokenPos());
  return offsets;
}
function parseStatement(code: string): { type: CanvasKind; name: string } | null {
  for (const type of ["hook", "agent", "approval"] as const) {
    const prefix = type === "hook" ? "await ports.hook(" : type === "agent" ? "await ports.agent(" : "if (!await ports.approve(";
    const suffix = type === "hook" ? ", input);" : type === "agent" ? ", 0);" : ")) throw new Error(\"approval denied\");";
    if (!code.startsWith(prefix) || !code.endsWith(suffix)) continue;
    try {
      const name: unknown = JSON.parse(code.slice(prefix.length, -suffix.length));
      validateName(name);
      if (statement(type, name) === code) return { type, name };
    } catch { /* User expressions are never managed. */ }
  }
  return null;
}
export function readCanvas(source: string): CanvasRegion | null {
  const starts = [...source.matchAll(BEGIN)], ends = [...source.matchAll(FINISH)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1) fail("expected exactly one start and end marker");
  const first = starts[0]!, last = ends[0]!;
  const start = (first.index ?? -1) + first[0].length, end = last.index ?? -1;
  if (start > end || first[1] !== last[1]) fail("misplaced or mismatched markers");
  const commentOffsets = comments(source);
  if (!commentOffsets.has((first.index ?? -1) + first[1]!.length) ||
      !commentOffsets.has((last.index ?? -1) + last[1]!.length)) {
    fail("markers must be actual standalone // comments, not block-comment or string contents");
  }
  if (!supportedScope(source, start, end)) fail("markers must be at top level of async runWorkflow(input, ports), before return");
  const indent = first[1]!, eol = first[0].endsWith("\r\n") ? "\r\n" : "\n";
  const body = source.slice(start, end), seen = new Set<string>();
  function unique(id: string) { if (seen.has(id)) fail("duplicate managed id"); seen.add(id); }
  function stepAt(cursor: number, pad: string, lane: CanvasLane): [CanvasStep, number] | null {
    const regex = new RegExp("^" + escapeRegex(pad) + "// @pi-workflows:step (" + ID + ")\\r?\\n" +
      escapeRegex(pad) + "([^\\r\\n]+)\\r?\\n");
    const match = regex.exec(body.slice(cursor));
    if (!match) return null;
    if (!commentOffsets.has(start + cursor + pad.length)) fail("managed marker is not a standalone comment");
    const parsed = parseStatement(match[2]!);
    if (!parsed) fail("unsupported statement in canvas region; edit source manually");
    unique(match[1]!);
    return [{ id: match[1]!, ...parsed, lane, start: start + cursor,
      end: start + cursor + match[0].length }, cursor + match[0].length];
  }
  const items: CanvasItem[] = [];
  let branch: CanvasBranch | null = null, cursor = 0;
  const branchRegex = new RegExp("^" + escapeRegex(indent) + "// @pi-workflows:branch (" + ID + ")\\r?\\n" +
    escapeRegex(indent) + "if \\(input\\.requiresApproval\\) \\{\\r?\\n");
  while (cursor < body.length) {
    const step = stepAt(cursor, indent, "top");
    if (step) { items.push(step[0]); cursor = step[1]; continue; }
    const match = branchRegex.exec(body.slice(cursor));
    if (!match) fail("unrecognized code in canvas region; edit source manually");
    if (branch) fail("only one source-mapped if/else branch is supported");
    if (!commentOffsets.has(start + cursor + indent.length)) fail("branch marker is not a standalone comment");
    const beginning = cursor;
    unique(match[1]!);
    cursor += match[0].length;
    const then: CanvasStep[] = [], otherwise: CanvasStep[] = [];
    const separator = indent + "} else {" + eol;
    while (!body.startsWith(separator, cursor)) {
      const next = stepAt(cursor, indent + "  ", "then");
      if (!next) fail("unsupported true-arm code; edit source manually");
      then.push(next[0]); cursor = next[1];
    }
    cursor += separator.length;
    const close = indent + "}" + eol;
    while (!body.startsWith(close, cursor)) {
      const next = stepAt(cursor, indent + "  ", "else");
      if (!next) fail("unsupported false-arm code; edit source manually");
      otherwise.push(next[0]); cursor = next[1];
    }
    cursor += close.length;
    branch = { id: match[1]!, type: "branch", start: start + beginning, end: start + cursor,
      then, else: otherwise };
    items.push(branch);
  }
  const steps = items.flatMap(item => item.type === "branch" ? [...item.then, ...item.else] : [item]);
  return { start, end, indent, eol, items, steps, branch };
}
export interface SourceEdge { id: string; from: string; to: string; kind: "sequence" | "then" | "else" | "join" }
export function canvasOrder(source: string): SourceEdge[] {
  const items = readCanvas(source)?.items ?? [], edges: SourceEdge[] = [];
  const edge = (from: string, to: string, kind: SourceEdge["kind"]) =>
    { if (!edges.some(e => e.from === from && e.to === to && e.kind === kind))
        edges.push({ id: "source_" + kind + "_" + from + "_" + to, from, to, kind }); };
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!, next = items[i]!;
    if (prev.type !== "branch") edge(prev.id, next.id, "sequence");
  }
  for (const [i, item] of items.entries()) {
    if (item.type !== "branch") continue;
    const after = items[i + 1];
    for (const arm of ["then", "else"] as const) {
      const steps = item[arm];
      if (steps.length) edge(item.id, steps[0]!.id, arm);
      for (let j = 1; j < steps.length; j++) edge(steps[j - 1]!.id, steps[j]!.id, "sequence");
      if (after) edge(steps.at(-1)?.id ?? item.id, after.id, "join");
    }
  }
  return edges;
}
async function anchor(source: string, start: number, end: number) {
  return { start, end, sha256: await sha256(source.slice(start, end)) };
}
/** Source-mapped moves only; unknown user code and run-time Pi semantics are never inferred. */
export async function editCanvas(workflow: LoadedWorkflow, operation: CanvasOperation): Promise<LoadedWorkflow> {
  const region = readCanvas(workflow.source);
  if (!region) fail("no editable region; add canvas markers to workflow.ts");
  const items: CanvasItem[] = region.items.map(item => item.type === "branch"
    ? { ...item, then: item.then.map(s => ({ ...s })), else: item.else.map(s => ({ ...s })) }
    : { ...item });
  let branch = items.find((item): item is CanvasBranch => item.type === "branch");
  const oldIds = new Set([...region.steps.map(s => s.id), ...(region.branch ? [region.branch.id] : [])]);
  let added: { id: string; x: number; y: number } | undefined;
  function locate(id: string): { step: CanvasStep; list: CanvasStep[]; index: number } | null {
    const topIndex = items.findIndex(item => item.type !== "branch" && item.id === id);
    if (topIndex >= 0) {
      return { step: items[topIndex]! as CanvasStep, list: items as CanvasStep[], index: topIndex };
    }
    for (const list of branch ? [branch.then, branch.else] : []) {
      const index = list.findIndex(item => item.id === id);
      if (index >= 0) return { step: list[index]!, list, index };
    }
    return null;
  }
  switch (operation.type) {
    case "add-step": {
      if (!["hook", "agent", "approval"].includes(operation.kind)) fail("unsupported step");
      validateName(operation.name); position(operation.x, operation.y);
      const id = newId();
      items.push({ id, type: operation.kind, name: operation.name, lane: "top", start: 0, end: 0 });
      added = { id, x: operation.x, y: operation.y };
      break;
    }
    case "remove-step": {
      const hit = locate(operation.id);
      if (!hit) fail("unknown managed step");
      hit.list.splice(hit.index, 1); break;
    }
    case "rename-step": {
      validateName(operation.name);
      const hit = locate(operation.id);
      if (!hit) fail("unknown managed step");
      if (hit.step.name === operation.name) return workflow;
      hit.step.name = operation.name; break;
    }
    case "connect-step": {
      const from = locate(operation.from), to = locate(operation.to);
      if (!from || !to || from.step.id === to.step.id) fail("connect two different managed steps");
      if (from.list !== to.list) fail("cross-lane rewiring requires a typed branch output");
      if (to.index === from.index + 1) return workflow;
      to.list.splice(to.index, 1);
      to.list.splice(to.list.findIndex(s => s.id === operation.from) + 1, 0, to.step);
      break;
    }
    case "add-branch": {
      position(operation.x, operation.y);
      if (branch) fail("only one source-mapped branch is supported");
      const id = newId();
      branch = { id, type: "branch", start: 0, end: 0, then: [], else: [] };
      items.push(branch); added = { id, x: operation.x, y: operation.y };
      break;
    }
    case "remove-branch": {
      if (!branch || operation.id !== branch.id) fail("unknown managed branch");
      if (branch.then.length || branch.else.length) fail("disconnect branch steps before deleting it");
      items.splice(items.indexOf(branch), 1); branch = undefined; break;
    }
    case "connect-branch": {
      if (!branch || operation.from !== branch.id) fail("unknown managed branch");
      if (operation.arm !== "then" && operation.arm !== "else") fail("unsupported branch output port");
      const hit = locate(operation.to);
      if (!hit) fail("unknown managed step");
      if (hit.list === branch[operation.arm] && hit.index === branch[operation.arm].length - 1) return workflow;
      hit.list.splice(hit.index, 1);
      hit.step.lane = operation.arm;
      branch[operation.arm].push(hit.step);
      break;
    }
    case "disconnect-branch": {
      if (!branch) fail("unknown managed branch");
      const hit = locate(operation.id);
      if (!hit || hit.step.lane === "top") fail("step is not inside a managed branch");
      hit.list.splice(hit.index, 1);
      hit.step.lane = "top";
      items.splice(items.indexOf(branch) + 1, 0, hit.step);
      break;
    }
    default: return fail("unsupported canvas operation");
  }
  const replacement = items.map(item => encodedItem(item, region.indent, region.eol)).join("");
  if (replacement === workflow.source.slice(region.start, region.end)) return workflow;
  const source = workflow.source.slice(0, region.start) + replacement + workflow.source.slice(region.end);
  const delta = replacement.length - (region.end - region.start);
  const next = readCanvas(source)!;
  const hash = await sha256(source);
  const managed = [
    ...next.steps.map(s => ({ id: s.id, type: s.type, name: s.name, start: s.start, end: s.end })),
    ...(next.branch ? [{ id: next.branch.id, type: "branch", name: "", start: next.branch.start, end: next.branch.end }] : []),
  ];
  const retained = new Set(managed.map(s => s.id));
  const oldManaged = [...region.steps, ...(region.branch ? [region.branch] : [])];
  const nodes: WorkflowLayout["nodes"][number][] = [];
  for (const node of workflow.layout?.nodes ?? []) {
    const old = node.anchor;
    if (oldIds.has(node.id)) {
      if (!old || !oldManaged.some(s => s.id === node.id && old.start === s.start && old.end === s.end)) fail("managed step/branch anchor mismatch");
      continue;
    }
    if (!old) { nodes.push(node); continue; }
    let a = old.start, b = old.end;
    if (b <= region.start) { /* before */ }
    else if (a >= region.end) { a += delta; b += delta; }
    else if (a <= region.start && b >= region.end) { b += delta; }
    else fail("unmanaged anchor overlaps canvas region; edit source manually");
    nodes.push({ ...node, anchor: await anchor(source, a, b) });
  }
  for (const [i, item] of managed.entries()) {
    const old = workflow.layout?.nodes.find(n => n.id === item.id);
    nodes.push({
      id: item.id, kind: "known",
      label: item.type === "branch" ? "If input.requiresApproval" : "ports." + item.type + " (" + item.name + ")",
      x: old ? old.x : added?.id === item.id ? added.x : 70 + i * 280,
      y: old ? old.y : added?.id === item.id ? added.y : 80,
      anchor: await anchor(source, item.start, item.end),
    });
  }
  const edges = (workflow.layout?.edges ?? []).filter(e =>
    (!oldIds.has(e.from) || retained.has(e.from)) && (!oldIds.has(e.to) || retained.has(e.to)));
  const layout: WorkflowLayout = { schemaVersion: 1, sourceSha256: hash, nodes, edges };
  return loadWorkflow({
    source, manifestJson: JSON.stringify({ ...workflow.manifest, sourceSha256: hash }, null, 2) + "\n",
    layoutJson: JSON.stringify(layout, null, 2) + "\n",
  });
}
