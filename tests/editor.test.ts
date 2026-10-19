import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { exportWorkflow, loadWorkflow, sha256, type WorkflowFiles } from "../src/artifact.ts";
import { editCode, editKnownName, moveProjectedNode, projectWorkflow } from "../src/editor.ts";
import { readPackage, startEditor } from "../src/editor-server.ts";
import { editCanvas, readCanvas } from "../src/canvas.ts";

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


test("anchored custom callback can change in code without losing its source mapping", async () => {
  const input = await files();
  const marked = "const mapped = (n: number) => n * 2;";
  const start = input.source.indexOf(marked);
  assert.ok(start >= 0);
  const layout = {
    schemaVersion: 1, sourceSha256: await sha256(input.source),
    nodes: [{
      id: "callback", kind: "known", label: "Custom callback", x: 120, y: 60,
      anchor: { start, end: start + marked.length, sha256: await sha256(marked) },
    }],
    edges: [],
  };
  const loaded = await loadWorkflow({ ...input, layoutJson: JSON.stringify(layout) });
  const changed = await editCode(loaded, input.source.replace("n * 2;", "n * 3;"));
  const span = changed.layout?.nodes.find(n => n.id === "callback")?.anchor;
  assert.ok(span);
  assert.equal(changed.source.slice(span.start, span.end), marked.replace("n * 2;", "n * 3;"));
  assert.equal(span.sha256, await sha256(changed.source.slice(span.start, span.end)));
  assert.equal((await projectWorkflow(changed)).nodes.find(n => n.id === "callback")?.category, "opaque");
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
    if (server) {
      const running = server;
      await new Promise<void>((done, reject) =>
        running.close(error => error ? reject(error) : done()));
    }
    await rm(folder, { recursive: true, force: true });
  }
});

test("split UTF-8 HTTP chunks round-trip Unicode literal values without replacement chars", async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-workflow-unicode-"));
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    const input = await files();
    await writeFile(join(folder, "workflow.ts"), input.source);
    await writeFile(join(folder, "workflow.json"), input.manifestJson);
    server = await startEditor(folder, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const name = "日本 🍃 naïve";
    const payload = Buffer.from(JSON.stringify({
      type: "property", id: "ast_hook_1", value: name, revision: 0,
    }), "utf8");
    const split = payload.indexOf(Buffer.from("🍃")) + 2;
    assert.ok(split > 2 && split < payload.length);
    const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        hostname: "127.0.0.1", port: address.port, path: "/api/action", method: "POST",
        headers: { "content-type": "application/json", "x-workflow-editor": "1" },
      }, res => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.write(payload.subarray(0, split));
      setTimeout(() => req.end(payload.subarray(split)), 20);
    });
    assert.equal(status.status, 200, status.body);
    const updated = JSON.parse(status.body) as { files: WorkflowFiles };
    assert.match(updated.files.source, /日本 🍃 naïve/);
    assert.ok(!updated.files.source.includes("\uFFFD"), "no replacement characters introduced by chunk split");
    const workflow = await loadWorkflow(updated.files);
    const graph = await projectWorkflow(workflow);
    assert.equal(graph.nodes.find(n => n.id === "ast_hook_1")?.editable?.value, name);
  } finally {
    if (server) {
      const running = server;
      await new Promise<void>((done, reject) => running.close(error => error ? reject(error) : done()));
    }
    await rm(folder, { recursive: true, force: true });
  }
});

test("concurrent stale edits and save requests serialize and return HTTP 409", async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-workflow-concurrency-"));
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    const input = await files();
    await writeFile(join(folder, "workflow.ts"), input.source);
    await writeFile(join(folder, "workflow.json"), input.manifestJson);
    server = await startEditor(folder, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const post = (revision: number, type: string, x?: number) =>
      fetch(base + "/api/action", {
        method: "POST", headers: { "content-type": "application/json", "x-workflow-editor": "1" },
        body: JSON.stringify({ type, id: "ast_hook_1", x, y: 100, revision }),
      });
    const [first, second] = await Promise.all([post(0, "move", 300), post(0, "move", 400)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const initialState = await fetch(base + "/api/state").then(r => r.json()) as {
      revision: number; graph: { nodes: Array<{ id: string; x: number }> };
    };
    assert.equal(initialState.revision, 1);
    const node = initialState.graph.nodes.find(n => n.id === "ast_hook_1");
    assert.ok(node && [300, 400].includes(node.x));
    const [save, moved] = await Promise.all([post(1, "save"), post(1, "move", 500)]);
    assert.deepEqual([save.status, moved.status].sort(), [200, 409]);
    const final = await fetch(base + "/api/state").then(r => r.json()) as { revision: number };
    assert.equal(final.revision, 2);
    // A failed action does not poison the queue; a request with a fresh revision succeeds.
    const accepted = await post(2, "move", 520);
    assert.equal(accepted.status, 200, await accepted.text());
  } finally {
    if (server) {
      const running = server;
      await new Promise<void>((done, reject) => running.close(error => error ? reject(error) : done()));
    }
    await rm(folder, { recursive: true, force: true });
  }
});

test("managed canvas steps create executable TypeScript in a bounded region and preserve unrelated source", async () => {
  const original = await loadWorkflow(await files());
  const starting = await projectWorkflow(original);
  assert.equal(starting.canvasEnabled, true);
  assert.deepEqual(starting.sequenceEdges, []);
  const hook = await editCanvas(original, { type: "add-step", kind: "hook", name: "audit", x: 420, y: 200 });
  const firstId = readCanvas(hook.source)!.steps[0]!.id;
  assert.match(hook.source, /await ports.hook\("audit", input\);/);
  assert.equal(hook.source.replace(hook.source.slice(readCanvas(hook.source)!.start, readCanvas(hook.source)!.end), ""),
    original.source);
  assert.equal(hook.manifest.sourceSha256, await sha256(hook.source));
  assert.equal((await projectWorkflow(hook)).nodes.find(n => n.id === firstId)?.x, 420);
  const agent = await editCanvas(hook, { type: "add-step", kind: "agent", name: "scorer", x: 680, y: 200 });
  const secondId = readCanvas(agent.source)!.steps[1]!.id;
  const approval = await editCanvas(agent, { type: "add-step", kind: "approval", name: "Proceed?", x: 940, y: 200 });
  const thirdId = readCanvas(approval.source)!.steps[2]!.id;
  assert.equal((await projectWorkflow(approval)).sequenceEdges.length, 2);
  assert.match(approval.source, /if \(!await ports.approve\("Proceed\?"\)\) throw new Error\("approval denied"\);/);
  const reordered = await editCanvas(approval, { type: "connect-step", from: firstId, to: thirdId });
  assert.deepEqual(readCanvas(reordered.source)!.steps.map(s => s.id), [firstId, thirdId, secondId]);
  assert.equal((await editCanvas(reordered, { type: "connect-step", from: firstId, to: thirdId })).source, reordered.source);
  const renamed = await editCanvas(reordered, { type: "rename-step", id: firstId, name: "after-change" });
  assert.equal(readCanvas(renamed.source)!.steps[0]!.name, "after-change");
  const moved = await moveProjectedNode(renamed, firstId, 520, 280);
  assert.equal((await projectWorkflow(moved)).nodes.find(n => n.id === firstId)?.y, 280);
  let final = moved;
  for (const id of [thirdId, secondId, firstId]) final = await editCanvas(final, { type: "remove-step", id });
  assert.equal(final.source, original.source, "removing all managed steps restores exact source bytes");
  assert.equal(final.manifest.sourceSha256, original.manifest.sourceSha256);
  assert.deepEqual(readCanvas(final.source)!.steps, []);
});

test("canvas rejects unmarked, unknown, overlapping and noncanonical edits", async () => {
  const input = await files();
  const original = await loadWorkflow(input);
  const noCanvas = input.source.replace("  // @pi-workflows:canvas-start\n  // @pi-workflows:canvas-end\n", "");
  const noCanvasWorkflow = await loadWorkflow({
    ...input, source: noCanvas, manifestJson: JSON.stringify({ ...original.manifest, sourceSha256: await sha256(noCanvas) }),
  });
  await assert.rejects(editCanvas(noCanvasWorkflow, { type: "add-step", kind: "hook", name: "x", x: 0, y: 0 }), /no editable region/);
  const markerPair = "  // @pi-workflows:canvas-start\n  // @pi-workflows:canvas-end\n";
  const outOfScope = input.source.replace(markerPair, "") +
    "// @pi-workflows:canvas-start\n// @pi-workflows:canvas-end\n";
  const wrongScope = await loadWorkflow({
    source: outOfScope,
    manifestJson: JSON.stringify({ ...original.manifest, sourceSha256: await sha256(outOfScope) }),
  });
  await assert.rejects(editCanvas(wrongScope, { type: "add-step", kind: "hook", name: "x", x: 0, y: 0 }), /top level of async runWorkflow/);
  await assert.rejects(editCanvas(original, { type: "remove-step", id: "missing" }), /unknown managed/);
  await assert.rejects(editCanvas(original, { type: "add-step", kind: "hook", name: "bad", x: Infinity, y: 0 }), /coordinates/);
  const withStep = await editCanvas(original, { type: "add-step", kind: "hook", name: "valid", x: 0, y: 0 });
  const changed = withStep.source.replace('await ports.hook("valid", input);', 'await ports.hook(getName(), input);');
  const untrusted = await loadWorkflow({
    ...withStep.files, source: changed,
    manifestJson: JSON.stringify({ ...withStep.manifest, sourceSha256: await sha256(changed) }),
    layoutJson: undefined,
  });
  await assert.rejects(editCanvas(untrusted, { type: "add-step", kind: "hook", name: "no", x: 0, y: 0 }), /unsupported statement/);
  const withAnchor = await moveProjectedNode(original, "ast_hook_1", 230, 150);
  const add = await editCanvas(withAnchor, { type: "add-step", kind: "hook", name: "extra", x: 300, y: 80 });
  assert.equal((await projectWorkflow(add)).nodes.find(n => n.id === "ast_hook_1")?.x, 230);
  await assert.rejects(editCanvas(add, { type: "connect-step", from: "ast_hook_1", to: readCanvas(add.source)!.steps[0]!.id }), /different managed/);
});

test("local server can add, connect, remove and save executable canvas nodes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-workflow-canvas-"));
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  try {
    const initial = await files();
    await writeFile(join(folder, "workflow.ts"), initial.source);
    await writeFile(join(folder, "workflow.json"), initial.manifestJson);
    server = await startEditor(folder, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const post = (revision: number, type: string, fields: Record<string, unknown>) => fetch(base + "/api/action", {
      method: "POST", headers: { "content-type": "application/json", "x-workflow-editor": "1" },
      body: JSON.stringify({ type, revision, ...fields }),
    });
    let a = await post(0, "add-step", { kind: "hook", name: "one", x: 100, y: 100 });
    assert.equal(a.status, 200, await a.clone().text());
    let snapshot = await a.json() as { revision: number; graph: { nodes: Array<{ id: string; canvasKind?: string }>; sequenceEdges: unknown[] } };
    const one = snapshot.graph.nodes.find(n => n.canvasKind === "hook")!.id;
    a = await post(snapshot.revision, "add-step", { kind: "hook", name: "two", x: 400, y: 100 });
    assert.equal(a.status, 200, await a.clone().text());
    snapshot = await a.json();
    const two = snapshot.graph.nodes.find(n => n.canvasKind === "hook" && n.id !== one)!.id;
    assert.equal(snapshot.graph.sequenceEdges.length, 1);
    const stale = await post(0, "remove-step", { id: two });
    assert.equal(stale.status, 409);
    a = await post(snapshot.revision, "connect-step", { from: two, to: one });
    assert.equal(a.status, 200, await a.clone().text());
    snapshot = await a.json();
    a = await post(snapshot.revision, "remove-step", { id: one });
    assert.equal(a.status, 200, await a.clone().text());
    snapshot = await a.json();
    a = await post(snapshot.revision, "save", {});
    assert.equal(a.status, 200, await a.clone().text());
    const sourceAfter = await readFile(join(folder, "workflow.ts"), "utf8");
    assert.match(sourceAfter, /await ports.hook\("two", input\);/);
    assert.doesNotMatch(sourceAfter, /await ports.hook\("one", input\);/);
    const savedPackage = await loadWorkflow(await readPackage(folder));
    assert.equal(savedPackage.source, sourceAfter);
    assert.equal(savedPackage.manifest.sourceSha256, await sha256(sourceAfter));
  } finally {
    if (server) await new Promise<void>((done, reject) => server!.close(e => e ? reject(e) : done()));
    await rm(folder, { recursive: true, force: true });
  }
});
