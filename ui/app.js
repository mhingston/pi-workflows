import { displaySource, sourceFromTextarea } from "./source-text.js";
const $ = (id) => document.getElementById(id);
let state = null;
let runtimeGraph = null;
let selected = null;
let positions = new Map();
let dragging = null;
let codeDraft = false;
let pendingAction = false;
const downloadUrls = new Set();

function closeDownloads() {
  const old = $("downloads");
  if (!old) return false;
  old.remove();
  for (const url of downloadUrls) {
    // Let any in-flight browser download consume its object URL first.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  downloadUrls.clear();
  return true;
}

function message(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
async function api(type, fields = {}) {
  if (!state) return;
  if (pendingAction) {
    message("An editor action is already in progress.", true);
    return;
  }
  if (codeDraft && type !== "code" && type !== "reload") {
    message("Apply or discard your code-pane draft before changing graph properties or layout.", true);
    return;
  }
  const submittedDraft = $("code").value;
  pendingAction = true;
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workflow-editor": "1" },
      body: JSON.stringify({ type, revision: state.revision, ...fields }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    state = result;
    // Only acknowledge the exact draft submitted. Text typed during the
    // request must survive the incoming state/render.
    if ((type === "code" || type === "reload") && $("code").value === submittedDraft) {
      codeDraft = false;
    }
    render();
    message(type === "save" ? "Package saved to disk." :
      type === "reload" ? "Package reloaded." : "Applied " + type + " change in memory. Save to disk when ready.");
  } catch (error) {
    message(error.message, true);
    if (!codeDraft && state) render(); // Revert optimistic dragging on rejected changes.
  } finally {
    pendingAction = false;
  }
}
async function load() {
  try {
    const response = await fetch("/api/state");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Cannot load package");
    state = result;
    render();
    message("Loaded a static projection — no workflow process is running.");
  } catch (error) { message(error.message, true); }
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
function render() {
  if (!state) return;
  const manifest = JSON.parse(state.files.manifestJson);
  $("workflow-title").textContent = manifest.id + "  v" + manifest.version;
  $("dirty").textContent = state.dirty ? "Unsaved changes" : "Unmodified";
  $("dirty").classList.toggle("dirty", state.dirty);
  $("notice").textContent = state.graph.notice;
  const enabled = Boolean(state.graph.canvasEnabled);
  $("palette").classList.toggle("unavailable", !enabled);
  $("canvas-mode").textContent = enabled
    ? "Drag steps to author TypeScript; one IF branch may route steps to TRUE/FALSE arms."
    : "Visual authoring disabled: add canvas-start/end markers inside runWorkflow in TypeScript.";
  for (const button of document.querySelectorAll(".palette-step")) button.disabled = !enabled ||
    (button.dataset.kind === "branch" && state.graph.nodes.some(n => n.canvasBranch));
  closeDownloads(); // Existing Blob URLs refer to an older artifact snapshot.
  if ($("code").value === displaySource(state.files.source)) codeDraft = false;
  if (!codeDraft) $("code").value = displaySource(state.files.source);
  positions = new Map(state.graph.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
  renderNodes();
  inspect();
}
function renderRuntimeGraph() {
  const container = $("run-nodes");
  container.replaceChildren();
  if (!runtimeGraph) return;
  const byParent = new Map();
  for (const node of runtimeGraph.nodes) {
    const key = node.parentTaskId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), node]);
  }
  const used = new Set();
  function append(parent, list) {
    for (const node of byParent.get(parent) ?? []) {
      if (used.has(node.taskId)) continue;
      used.add(node.taskId);
      const item = document.createElement("li");
      item.append(text("strong", "#" + node.taskId + " " + node.kind));
      item.append(text("span", node.status + (node.phase ? " · " + node.phase : "") +
        (node.outcome ? " · " + node.outcome : ""), "runtime-state"));
      list.append(item);
      const children = document.createElement("ul");
      append(node.taskId, children);
      if (children.childElementCount) item.append(children);
    }
  }
  append(null, container);
  // The parent run may itself have another owner; its view is rooted here.
  if (!container.childElementCount) append(runtimeGraph.nodes[0]?.parentTaskId ?? null, container);
}
async function inspectRun() {
  const input = $("run-id");
  const runId = input.value.trim();
  if (!/^[1-9][0-9]*$/.test(runId) || !Number.isSafeInteger(Number(runId))) {
    $("run-message").textContent = "Enter a valid native task ID.";
    return;
  }
  try {
    const response = await fetch("/api/run-graph?runId=" + encodeURIComponent(runId));
    const graph = await response.json();
    if (!response.ok) throw new Error(graph.error || "Run inspection failed");
    runtimeGraph = graph;
    renderRuntimeGraph();
    const manifest = JSON.parse(state.files.manifestJson);
    const different = manifest.version !== graph.workflowVersion ||
      manifest.sourceSha256 !== graph.sourceSha256;
    $("run-message").textContent = "Run #" + graph.runId + " · " + graph.workflowId +
      "@" + graph.workflowVersion + " · " + graph.nodes.length + " native tasks" +
      (different ? " · Different published revision from current editor source." : "") +
      (graph.hierarchyComplete ? "" : " · Child hierarchy incomplete (missing native receipts).") +
      " · Snapshot only; refresh to update. No model/hook telemetry.";
  } catch (error) {
    runtimeGraph = null;
    renderRuntimeGraph();
    $("run-message").textContent = error.message;
  }
}
function stageSize() {
  const list = [...positions.values()];
  const width = Math.max(1100, ...list.map(p => p.x + 350));
  const height = Math.max(740, ...list.map(p => p.y + 190));
  $("stage").style.width = width + "px";
  $("stage").style.height = height + "px";
  $("edges").setAttribute("width", width);
  $("edges").setAttribute("height", height);
}
function renderEdges() {
  stageSize();
  const svg = $("edges");
  svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(ns, "defs");
  const marker = document.createElementNS(ns, "marker");
  marker.setAttribute("id", "sequence-arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS(ns, "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.setAttribute("fill", "#72c7b5");
  marker.append(arrow);
  defs.append(marker);
  svg.append(defs);
  for (const edge of [...state.graph.edges, ...(state.graph.sequenceEdges ?? [])]) {
    const a = positions.get(edge.from), b = positions.get(edge.to);
    if (!a || !b) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = a.x + 240, y1 = a.y + 38, x2 = b.x, y2 = b.y + 38;
    const curve = Math.max(30, Math.abs(x2 - x1) / 2);
    path.setAttribute("d", "M " + x1 + " " + y1 + " C " +
      (x1 + curve) + " " + y1 + " " + (x2 - curve) + " " + y2 + " " + x2 + " " + y2);
    const executable = edge.kind !== "illustrative";
    path.setAttribute("class", executable ? "edge source-edge " + edge.kind : "edge");
    if (executable) path.setAttribute("marker-end", "url(#sequence-arrow)");
    svg.append(path);
  }
}
function renderNodes() {
  const container = $("nodes");
  container.replaceChildren();
  for (const node of state.graph.nodes) {
    const el = document.createElement("div");
    el.className = "node " + node.category + (selected === node.id ? " selected" : "");
    el.dataset.id = node.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", node.label + ", " + node.category);
    const pos = positions.get(node.id);
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
    el.append(text("small", node.category.toUpperCase(), "kind"));
    el.append(text("strong", node.label));
    el.append(text("small", node.canvasBranch ? "TRUE / FALSE source lanes" :
      node.canvasKind ? "Lane: " + (node.lane === "top" ? "sequential" : node.lane.toUpperCase()) :
      node.editable ? "Editable name" : "Source preserved", "detail"));
    if (node.canvasKind) {
      const input = text("button", "IN", "port input");
      input.type = "button";
      input.title = "Drop another managed step's output here to place this step after it";
      input.setAttribute("aria-label", "Step input: " + node.label);
      input.addEventListener("dragover", event => {
        if (event.dataTransfer?.types.includes("application/x-pi-connect") ||
            event.dataTransfer?.types.includes("application/x-pi-branch")) event.preventDefault();
      });
      input.addEventListener("drop", event => {
        event.preventDefault();
        event.stopPropagation();
        const branch = event.dataTransfer?.getData("application/x-pi-branch");
        if (branch) {
          try {
            const { from, arm } = JSON.parse(branch);
            api("connect-branch", { from, arm, to: node.id });
          } catch { message("Invalid branch connection.", true); }
          return;
        }
        const from = event.dataTransfer?.getData("application/x-pi-connect");
        if (from && from !== node.id) api("connect-step", { from, to: node.id });
      });
      const output = text("button", "OUT", "port output");
      output.type = "button";
      output.draggable = true;
      output.title = "Drag onto another managed step's input to place it immediately after this step";
      output.setAttribute("aria-label", "Step output: " + node.label);
      output.addEventListener("dragstart", event => {
        if (pendingAction || codeDraft) { event.preventDefault(); return; }
        event.dataTransfer.setData("application/x-pi-connect", node.id);
        event.dataTransfer.effectAllowed = "move";
      });
      el.append(input, output);
    }
    if (node.canvasBranch) {
      for (const arm of ["then", "else"]) {
        const output = text("button", arm === "then" ? "TRUE" : "FALSE", "port output " + arm);
        output.type = "button";
        output.draggable = true;
        output.title = "Connect this branch arm to a managed step's IN port";
        output.setAttribute("aria-label", arm + " branch output");
        output.addEventListener("dragstart", event => {
          if (pendingAction || codeDraft) { event.preventDefault(); return; }
          event.dataTransfer.setData("application/x-pi-branch", JSON.stringify({ from: node.id, arm }));
          event.dataTransfer.effectAllowed = "move";
        });
        el.append(output);
      }
    }
    el.addEventListener("click", () => select(node.id));
    el.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(node.id); }
    });
    el.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest(".port")) return;
      if (pendingAction) {
        message("Finish the current edit before dragging nodes.", true);
        return;
      }
      if (codeDraft) {
        message("Apply your code-pane draft before dragging nodes.", true);
        return;
      }
      select(node.id);
      dragging = { id: node.id, x: event.clientX, y: event.clientY, origin: { ...positions.get(node.id) } };
      el.setPointerCapture(event.pointerId);
    });
    el.addEventListener("pointermove", event => {
      if (!dragging || dragging.id !== node.id) return;
      const x = Math.max(0, Math.round(dragging.origin.x + event.clientX - dragging.x));
      const y = Math.max(0, Math.round(dragging.origin.y + event.clientY - dragging.y));
      positions.set(node.id, { x, y });
      el.style.left = x + "px";
      el.style.top = y + "px";
      renderEdges();
    });
    el.addEventListener("pointerup", () => {
      if (!dragging || dragging.id !== node.id) return;
      const previous = dragging.origin;
      const position = positions.get(node.id);
      dragging = null;
      if (position.x !== previous.x || position.y !== previous.y) {
        api("move", { id: node.id, x: position.x, y: position.y });
      }
    });
    el.addEventListener("pointercancel", () => {
      dragging = null;
      render();
    });
    container.append(el);
  }
  renderEdges();
}
function select(id) {
  selected = id;
  for (const el of $("nodes").children) el.classList.toggle("selected", el.dataset.id === id);
  inspect();
}
function inspect() {
  const inspector = $("inspector");
  inspector.replaceChildren();
  const node = state.graph.nodes.find(n => n.id === selected);
  if (!node) { inspector.append(text("p", "Select a node to inspect its source mapping.")); return; }
  inspector.append(text("h3", node.label));
  if (node.canvasKind) inspector.append(text("p", "Executable managed " + node.canvasKind +
    " step in " + (node.lane ?? "top") + " lane. Same-lane connections change statement order."));
  if (node.canvasBranch) inspector.append(text("p",
    "Fixed boolean condition: input.requiresApproval. TRUE and FALSE outputs move a step into the matching TypeScript arm."));
  inspector.append(text("p", "Kind: " + node.kind + " / " + node.category));
  inspector.append(text("p", node.anchor ?
    "UTF-16 source span: " + node.anchor.start + "–" + node.anchor.end :
    "No source anchor; code remains authoritative."));
  if (node.canvasBranch) {
    const remove = text("button", "Delete empty branch", "danger");
    remove.addEventListener("click", () => api("remove-branch", { id: node.id }));
    inspector.append(remove);
    return;
  }
  if (!node.editable) {
    inspector.append(text("p", "No safe visual properties. Edit unrecognized logic in the code pane."));
    return;
  }
  const label = text("label", "Literal name");
  const input = document.createElement("input");
  input.type = "text";
  input.value = node.editable.value;
  label.append(input);
  inspector.append(label);
  const button = text("button", "Apply name");
  button.addEventListener("click", () => api("property", { id: node.id, value: input.value }));
  inspector.append(button);
  if (node.canvasKind) {
    if (node.lane !== "top") {
      const leave = text("button", "Disconnect from branch (move after IF)");
      leave.addEventListener("click", () => api("disconnect-branch", { id: node.id }));
      inspector.append(leave);
    }
    const choice = text("label", "Place this step after");
    const select = document.createElement("select");
    for (const other of state.graph.nodes.filter(n => n.canvasKind && n.id !== node.id && n.lane === node.lane)) {
      const option = text("option", other.label);
      option.value = other.id;
      select.append(option);
    }
    choice.append(select);
    inspector.append(choice);
    const reorder = text("button", "Change source order");
    reorder.disabled = !select.options.length;
    reorder.addEventListener("click", () => api("connect-step", { from: select.value, to: node.id }));
    inspector.append(reorder);
    const remove = text("button", "Delete step", "danger");
    remove.addEventListener("click", () => {
      if (confirm("Delete this managed step and its executable statement?"))
        api("remove-step", { id: node.id });
    });
    inspector.append(remove);
  }
}
function downloads() {
  if (codeDraft) { message("Apply your code-pane draft before exporting.", true); return; }
  if (closeDownloads()) return;
  const panel = document.createElement("div");
  panel.id = "downloads";
  const files = [
    ["workflow.ts", state.files.source],
    ["workflow.json", state.files.manifestJson],
    ...(state.files.layoutJson === undefined ? [] : [["layout.json", state.files.layoutJson]]),
  ];
  for (const [name, value] of files) {
    const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
    downloadUrls.add(url);
    const link = text("a", "Download " + name);
    link.href = url;
    link.download = name;
    link.addEventListener("click", () => {
      // Keep URL live until navigation has consumed it.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, { once: true });
    panel.append(link);
  }
  $("download").after(panel);
}
const defaults = { hook: "new hook", agent: "new agent", approval: "Review required", branch: "" };
for (const button of document.querySelectorAll(".palette-step")) {
  const kind = button.dataset.kind;
  button.addEventListener("dragstart", event => {
    if (pendingAction || codeDraft || !state?.graph.canvasEnabled) { event.preventDefault(); return; }
    event.dataTransfer.setData("application/x-pi-step", kind);
    event.dataTransfer.effectAllowed = "copy";
  });
  button.addEventListener("click", () => {
    const viewport = $("viewport");
    api(kind === "branch" ? "add-branch" : "add-step", { ...(kind === "branch" ? {} : { kind, name: defaults[kind] }),
      x: Math.max(0, Math.round(viewport.scrollLeft + viewport.clientWidth / 2 - 120)),
      y: Math.max(0, Math.round(viewport.scrollTop + viewport.clientHeight / 2 - 38)) });
  });
}
$("viewport").addEventListener("dragover", event => {
  if (event.dataTransfer?.types.includes("application/x-pi-step") && state?.graph.canvasEnabled) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
});
$("viewport").addEventListener("drop", event => {
  const kind = event.dataTransfer?.getData("application/x-pi-step");
  if (!Object.hasOwn(defaults, kind) || !state?.graph.canvasEnabled) return;
  event.preventDefault();
  const rect = $("stage").getBoundingClientRect();
  api(kind === "branch" ? "add-branch" : "add-step", { ...(kind === "branch" ? {} : { kind, name: defaults[kind] }),
    x: Math.max(0, Math.round(event.clientX - rect.left - 120)),
    y: Math.max(0, Math.round(event.clientY - rect.top - 38)) });
});
$("code").addEventListener("input", () => {
  codeDraft = $("code").value !== displaySource(state?.files.source ?? "");
});
$("apply-code").addEventListener("click", () => {
  if (!codeDraft) { message("No source changes to apply."); return; }
  api("code", { source: sourceFromTextarea(state.files.source, $("code").value) });
});
$("reload").addEventListener("click", () => {
  if (!state?.dirty && !codeDraft || confirm("Discard unsaved edits and reload files from disk?")) api("reload");
});
$("save").addEventListener("click", () => {
  if (codeDraft) { message("Apply or discard the code-pane draft before saving.", true); return; }
  api("save");
});
$("download").addEventListener("click", downloads);
$("inspect-run").addEventListener("click", inspectRun);
load();