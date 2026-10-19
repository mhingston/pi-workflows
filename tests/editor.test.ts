import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportWorkflow, loadWorkflow, sha256, type WorkflowFiles } from "../src/artifact.ts";
import { editCode, editKnownName, moveProjectedNode, projectWorkflow } from "../src/editor.ts";
import { startEditor } from "../src/editor-server.ts";

const source = await readFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), "utf8");
const rawManifest = await readFile(new URL("../fixtures/complex/workflow.json", import.meta.url), "utf8");
async function files(): Promise<WorkflowFiles> {
  return {
    source,
    manifestJson: JSON.stringify({
      ...JSON.parse(rawManifest) as Record<string, unknown>,
      sourceSha256: await sha256(source),
    }, null, 2) + "\n",
  };
}

test("branch, parallel, dynamic, literal calls and opaque code are projected without runtime edges", async () => {
  const input = await files();
  const workflow = await loadWorkflow(input);
  const graph = await projectWorkflow(workflow);
  assert.ok(graph.nodes.some(n => n.category === "branch"));
  assert.ok(graph.nodes.some(n => n.category === "parallel"));
  assert.ok(graph.nodes.some(n => n.category === "dynamic"));
  assert.ok(graph.nodes.some(n => n.category === "opaque"));
  assert.ok(graph.nodes.some(n => n.editable?.value === "worker"));
  assert.deepEqual(graph.edges, [], "AST traversal cannot infer runtime task edges");
  assert.deepEqual(exportWorkflow(workflow), input, "projection is read only and byte preserving");
});

test("dragged layout retains source exactly, and known field changes only one AST literal", async () => {
  const original = await loadWorkflow(await files());
  const call = (await projectWorkflow(original)).nodes.find(n => n.editable?.value === "before")!;
  const moved = await moveProjectedNode(original, call.id, 415, 210);
  assert.equal(moved.files.source, original.files.source);
  assert.equal(moved.files.manifestJson, original.files.manifestJson);
  assert.equal((await projectWorkflow(moved)).nodes.find(n => n.id === call.id)?.x, 415);
  assert.equal(moved.layout?.schemaVersion, 1);
  const edited = await editKnownName(moved, call.id, "ready");
  assert.equal(edited.source, original.source.replace('"before"', '"ready"'));
  assert.equal(edited.manifest.sourceSha256, await sha256(edited.source));
  assert.equal(edited.layout?.sourceSha256, edited.manifest.sourceSha256);
  assert.equal((await projectWorkflow(edited)).nodes.find(n => n.id === call.id)?.editable?.value, "ready");
  assert.equal(edited.layout?.nodes.find(n => n.id === call.id)?.x, 415);
  assert.deepEqual(exportWorkflow(await loadWorkflow(exportWorkflow(edited))), exportWorkflow(edited));
});

test("no-op visual edits never reformat any of the three package files", async () => {
  const initial = await loadWorkflow(await files());
  const moved = await moveProjectedNode(initial, "opaque_source", 180, 680);
  const before = exportWorkflow(moved);
  const copied = await loadWorkflow(before);
  assert.deepEqual(exportWorkflow(copied), before);
  assert.deepEqual(exportWorkflow(await editCode(copied, copied.source)), before);
  assert.deepEqual(exportWorkflow(await editKnownName(copied, "ast_hook_1", "before")), before);
  assert.deepEqual(exportWorkflow(await moveProjectedNode(copied, "opaque_source", 180, 680)), before);
});

test("opaque callback is editable in the code pane with layout and hashes preserved", async () => {
  const initial = await loadWorkflow(await files());
  const moved = await moveProjectedNode(initial, "opaque_source", 20, 20);
  const newSource = moved.source.replace("n * 2;", "n * 3;");
  const edited = await editCode(moved, newSource);
  assert.equal(edited.source, newSource);
  assert.ok(edited.layout);
  assert.equal(edited.layout?.sourceSha256, await sha256(newSource));
  assert.ok((await projectWorkflow(edited)).nodes.some(n => n.id === "opaque_source"));
});

test("unsafe edits and schema drift fail without silently dropping source", async () => {
  const input = await files();
  const original = await loadWorkflow(input);
  await assert.rejects(editKnownName(original, "ast_branch_1", "rewrite"), /no safely editable literal/);
  await assert.rejects(editKnownName(original, "missing", "new"), /no safely editable literal/);
  await assert.rejects(editCode(original, "function { broken"), /invalid TypeScript/);
  await assert.rejects(moveProjectedNode(original, "missing", 1, 2), /unknown node/);
  const manifest = JSON.parse(input.manifestJson) as Record<string, unknown>;
  await assert.rejects(loadWorkflow({
    ...input, manifestJson: JSON.stringify({ ...manifest, schemaVersion: 2 }),
  }), /unsupported manifest/);
  const moved = await moveProjectedNode(original, "ast_hook_1", 200, 100);
  const corrupt = JSON.parse(moved.files.layoutJson!) as {
    nodes: Array<{ anchor?: { sha256: string } }>;
  };
  corrupt.nodes[0]!.anchor!.sha256 = "0".repeat(64);
  await assert.rejects(loadWorkflow({ ...moved.files, layoutJson: JSON.stringify(corrupt) }), /anchor is stale/);
});

test("local browser viewer serves a versioned package without invoking the workflow", async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-workflow-editor-"));
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    const input = await files();
    await writeFile(join(folder, "workflow.ts"), input.source);
    await writeFile(join(folder, "workflow.json"), input.manifestJson);
    server = await startEditor(folder, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const html = await fetch(base).then(r => r.text());
    assert.match(html, /Graph projection/);
    const initial = await fetch(base + "/api/state").then(r => r.json()) as {
      revision: number; files: WorkflowFiles; graph: { nodes: unknown[] };
    };
    assert.equal(initial.files.source, input.source);
    assert.ok(initial.graph.nodes.length > 0);
    const changed = await fetch(base + "/api/action", {
      method: "POST", headers: { "content-type": "application/json", "x-workflow-editor": "1" },
      body: JSON.stringify({ type: "move", id: "ast_hook_1", x: 350, y: 120, revision: initial.revision }),
    });
    const changedBody = await changed.text();
    assert.equal(changed.status, 200, changedBody);
    const moved = JSON.parse(changedBody) as { revision: number };
    const saved = await fetch(base + "/api/action", {
      method: "POST", headers: { "content-type": "application/json", "x-workflow-editor": "1" },
      body: JSON.stringify({ type: "save", revision: moved.revision }),
    });
    assert.equal(saved.status, 200, await saved.text());
    assert.equal(await readFile(join(folder, "workflow.ts"), "utf8"), input.source);
    assert.ok(await readFile(join(folder, "layout.json"), "utf8"));
  } finally {
    if (server) await new Promise<void>((done, reject) =>
      server.close(error => error ? reject(error) : done()));
    await rm(folder, { recursive: true, force: true });
  }
});