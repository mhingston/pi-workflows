/** Source-first, lossless linear canvas authoring; no TypeScript execution. */
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { ArtifactError, loadWorkflow, sha256, type LoadedWorkflow, type WorkflowLayout } from "./artifact.ts";

export type CanvasKind = "hook" | "agent" | "approval";
export interface CanvasStep { id: string; type: CanvasKind; name: string; start: number; end: number }
export interface CanvasRegion { start: number; end: number; indent: string; eol: string; steps: CanvasStep[] }
export type CanvasOperation =
  | { type: "add-step"; kind: CanvasKind; name: string; x: number; y: number }
  | { type: "remove-step"; id: string }
  | { type: "rename-step"; id: string; name: string }
  | { type: "connect-step"; from: string; to: string };

const BEGIN = /^([ \t]*)\/\/ @pi-workflows:canvas-start[ \t]*\r?\n/gm;
const FINISH = /^([ \t]*)\/\/ @pi-workflows:canvas-end[ \t]*(?:\r?\n|$)/gm;
function fail(message: string): never { throw new ArtifactError("canvas: " + message); }
function validateName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 500) fail("step name must be 1–500 characters");
}
function statement(type: CanvasKind, name: string): string {
  const arg = JSON.stringify(name);
  switch (type) {
    case "hook": return "await ports.hook(" + arg + ", input);";
    case "agent": return "await ports.agent(" + arg + ", 0);";
    case "approval": return "if (!await ports.approve(" + arg + ")) throw new Error(\"approval denied\");";
  }
}
function encoded(s: Pick<CanvasStep, "id" | "type" | "name">, indent: string, eol: string): string {
  return indent + "// @pi-workflows:step " + s.id + eol + indent + statement(s.type, s.name) + eol;
}
/**
 * The small generated statement catalog assumes a top-level region inside an
 * async runWorkflow(input, ports) declaration. Never insert into a nested
 * branch, a different scope, or after an unconditional top-level return.
 */
function supportedScope(source: string, start: number, end: number): boolean {
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runWorkflow" &&
        node.body && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
        node.parameters.length >= 2 && ts.isIdentifier(node.parameters[0]!.name) &&
        node.parameters[0]!.name.text === "input" &&
        ts.isIdentifier(node.parameters[1]!.name) &&
        node.parameters[1]!.name.text === "ports") {
      const body = node.body;
      const inside = start > body.getStart(file) && end < body.end;
      // A preceding unbraced if/loop can consume the first managed step.
      // Test *both* boundaries: containing the whole region is insufficient,
      // since an if may consume only the first of several managed statements.
      const crossesBoundary = body.statements.some(statement => {
        const a = statement.getStart(file), b = statement.end;
        return (a < start && b > start) || (a < end && b > end);
      });
      const afterReturn = body.statements.some(statement =>
        ts.isReturnStatement(statement) && statement.getStart(file) < start);
      if (inside && !crossesBoundary && !afterReturn) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}
/**
 * Check marker positions against the TypeScript lexer. A line matching the
 * marker regex could otherwise be part of a block comment or template literal;
 * those are not executable authoring regions.
 */
function standaloneLineComments(source: string): Set<number> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const positions = new Set<number>();
  let token: ts.SyntaxKind;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) positions.add(scanner.getTokenPos());
  }
  return positions;
}

export function readCanvas(source: string): CanvasRegion | null {
  const starts = [...source.matchAll(BEGIN)], ends = [...source.matchAll(FINISH)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1) fail("expected exactly one start and end marker");
  const first = starts[0]!, last = ends[0]!;
  const start = (first.index ?? -1) + first[0].length, end = last.index ?? -1;
  if (start > end || first[1] !== last[1]) fail("misplaced or mismatched markers");
  const singleLineComments = standaloneLineComments(source);
  if (!singleLineComments.has((first.index ?? -1) + first[1]!.length) ||
      !singleLineComments.has((last.index ?? -1) + last[1]!.length)) {
    fail("markers must be actual standalone // comments, not block-comment or string contents");
  }
  if (!supportedScope(source, start, end)) fail("markers must be at top level of async runWorkflow(input, ports), before return");
  const indent = first[1]!, eol = first[0].endsWith("\r\n") ? "\r\n" : "\n";
  const body = source.slice(start, end);
  const pattern = new RegExp("^" + indent + "// @pi-workflows:step (canvas_[a-f0-9]{16})\\r?\\n" +
    indent + "([^\\r\\n]+)\\r?\\n", "gm");
  const steps: CanvasStep[] = [], seen = new Set<string>();
  let cursor = 0;
  while (cursor < body.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(body);
    if (!match || match.index !== cursor) fail("unrecognized code in canvas region; edit source manually");
    const id = match[1]!, code = match[2]!;
    if (seen.has(id)) fail("duplicate step id");
    seen.add(id);
    let parsed: { type: CanvasKind; name: string } | undefined;
    for (const type of ["hook", "agent", "approval"] as const) {
      const prefix = type === "hook" ? "await ports.hook(" : type === "agent" ?
        "await ports.agent(" : "if (!await ports.approve(";
      const suffix = type === "hook" ? ", input);" : type === "agent" ?
        ", 0);" : ")) throw new Error(\"approval denied\");";
      if (!code.startsWith(prefix) || !code.endsWith(suffix)) continue;
      try {
        const name: unknown = JSON.parse(code.slice(prefix.length, -suffix.length));
        validateName(name);
        if (statement(type, name) === code) parsed = { type, name };
      } catch { /* A user-authored expression must never be silently overwritten. */ }
    }
    if (!parsed) fail("unsupported statement in canvas region; edit source manually");
    steps.push({ id, ...parsed, start: start + cursor, end: start + cursor + match[0].length });
    cursor += match[0].length;
  }
  return { start, end, indent, eol, steps };
}
export function canvasOrder(source: string) {
  const steps = readCanvas(source)?.steps ?? [];
  return steps.slice(1).map((step, i) => ({
    id: "sequence_" + steps[i]!.id + "_" + step.id,
    from: steps[i]!.id, to: step.id, kind: "sequence" as const,
  }));
}
async function anchor(source: string, start: number, end: number) {
  return { start, end, sha256: await sha256(source.slice(start, end)) };
}
/**
 * Drag-connect A.out -> B.in reorders B directly after A in a linear
 * sequence. Neither arbitrary branching nor opaque-code rewiring is supported.
 */
export async function editCanvas(workflow: LoadedWorkflow, operation: CanvasOperation): Promise<LoadedWorkflow> {
  const region = readCanvas(workflow.source);
  if (!region) fail("no editable region; add canvas markers to workflow.ts");
  const steps = region.steps.map(step => ({ ...step }));
  const oldIds = new Set(steps.map(step => step.id));
  let added: { id: string; x: number; y: number } | undefined;
  switch (operation.type) {
    case "add-step": {
      if (!["hook", "agent", "approval"].includes(operation.kind)) fail("unsupported step");
      validateName(operation.name);
      if (!Number.isFinite(operation.x) || !Number.isFinite(operation.y) ||
          operation.x < 0 || operation.y < 0 || operation.x > 100000 || operation.y > 100000) {
        fail("invalid canvas coordinates");
      }
      const id = "canvas_" + randomUUID().replace(/-/g, "").slice(0, 16);
      steps.push({ id, type: operation.kind, name: operation.name, start: 0, end: 0 });
      added = { id, x: operation.x, y: operation.y };
      break;
    }
    case "remove-step": {
      const index = steps.findIndex(s => s.id === operation.id);
      if (index === -1) fail("unknown managed step");
      steps.splice(index, 1);
      break;
    }
    case "rename-step": {
      validateName(operation.name);
      const step = steps.find(s => s.id === operation.id);
      if (!step) fail("unknown managed step");
      if (step.name === operation.name) return workflow;
      step.name = operation.name;
      break;
    }
    case "connect-step": {
      const from = steps.findIndex(s => s.id === operation.from);
      const to = steps.findIndex(s => s.id === operation.to);
      if (from === -1 || to === -1 || from === to) fail("connect two different managed steps");
      if (to === from + 1) return workflow;
      const [step] = steps.splice(to, 1);
      steps.splice(steps.findIndex(s => s.id === operation.from) + 1, 0, step!);
      break;
    }
  }
  const replacement = steps.map(s => encoded(s, region.indent, region.eol)).join("");
  if (replacement === workflow.source.slice(region.start, region.end)) return workflow;
  const source = workflow.source.slice(0, region.start) + replacement + workflow.source.slice(region.end);
  const delta = replacement.length - (region.end - region.start);
  const newRegion = readCanvas(source)!;
  const hash = await sha256(source);
  const retained = new Set(newRegion.steps.map(s => s.id));
  const nodes: WorkflowLayout["nodes"][number][] = [];
  for (const node of workflow.layout?.nodes ?? []) {
    const old = node.anchor;
    if (oldIds.has(node.id)) {
      if (!old || !region.steps.some(s => s.id === node.id && old.start === s.start && old.end === s.end)) {
        fail("managed step anchor mismatch");
      }
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
  for (const [i, step] of newRegion.steps.entries()) {
    const old = workflow.layout?.nodes.find(n => n.id === step.id);
    nodes.push({
      id: step.id, kind: "known", label: "ports." + step.type + " (" + step.name + ")",
      x: old ? old.x : added?.id === step.id ? added.x : 70 + i * 280,
      y: old ? old.y : added?.id === step.id ? added.y : 80,
      anchor: await anchor(source, step.start, step.end),
    });
  }
  const edges = (workflow.layout?.edges ?? [])
    .filter(e => !oldIds.has(e.from) || retained.has(e.from))
    .filter(e => !oldIds.has(e.to) || retained.has(e.to));
  const layout: WorkflowLayout = { schemaVersion: 1, sourceSha256: hash, nodes, edges };
  return loadWorkflow({
    source, manifestJson: JSON.stringify({ ...workflow.manifest, sourceSha256: hash }, null, 2) + "\n",
    layoutJson: JSON.stringify(layout, null, 2) + "\n",
  });
}
