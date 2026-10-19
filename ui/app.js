const $ = (id) => document.getElementById(id);
let state = null;
let selected = null;
let positions = new Map();
let dragging = null;
let codeDraft = false;

function message(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
async function api(type, fields = {}) {
  if (!state) return;
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workflow-editor": "1" },
      body: JSON.stringify({ type, revision: state.revision, ...fields }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    state = result;
    codeDraft = false;
    render();
    message(type === "save" ? "Package saved to disk." :
      type === "reload" ? "Package reloaded." : "Applied " + type + " change in memory. Save to disk when ready.");
  } catch (error) {
    message(error.message, true);
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
  $("code").value = state.files.source;
  positions = new Map(state.graph.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
  renderNodes();
  inspect();
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
  for (const edge of state.graph.edges) {
    const a = positions.get(edge.from), b = positions.get(edge.to);
    if (!a || !b) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = a.x + 240, y1 = a.y + 38, x2 = b.x, y2 = b.y + 38;
    const curve = Math.max(30, Math.abs(x2 - x1) / 2);
    path.setAttribute("d", "M " + x1 + " " + y1 + " C " +
      (x1 + curve) + " " + y1 + " " + (x2 - curve) + " " + y2 + " " + x2 + " " + y2);
    path.setAttribute("class", "edge");
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
    el.append(text("small", node.editable ? "Editable name" : "Source preserved", "detail"));
    el.addEventListener("click", () => select(node.id));
    el.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(node.id); }
    });
    el.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
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
  inspector.append(text("p", "Kind: " + node.kind + " / " + node.category));
  inspector.append(text("p", node.anchor ?
    "UTF-16 source span: " + node.anchor.start + "–" + node.anchor.end :
    "No source anchor; code remains authoritative."));
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
}
function downloads() {
  const old = $("downloads");
  if (old) { old.remove(); return; }
  const panel = document.createElement("div");
  panel.id = "downloads";
  const files = [
    ["workflow.ts", state.files.source],
    ["workflow.json", state.files.manifestJson],
    ...(state.files.layoutJson === undefined ? [] : [["layout.json", state.files.layoutJson]]),
  ];
  for (const [name, value] of files) {
    const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
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
$("code").addEventListener("input", () => { codeDraft = $("code").value !== state?.files.source; });
$("apply-code").addEventListener("click", () => api("code", { source: $("code").value }));
$("reload").addEventListener("click", () => {
  if (!state?.dirty && !codeDraft || confirm("Discard unsaved edits and reload files from disk?")) api("reload");
});
$("save").addEventListener("click", () => {
  if (codeDraft) { message("Apply or discard the code-pane draft before saving.", true); return; }
  api("save");
});
$("download").addEventListener("click", downloads);
load();