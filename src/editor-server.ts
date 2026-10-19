/**
 * Local-only workflow editor host. Explicitly selected trusted package only:
 * reads/writes files, never imports or executes workflow.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { exportWorkflow, loadWorkflow, type LoadedWorkflow, type WorkflowFiles } from "./artifact.ts";
import { editCode, editKnownName, moveProjectedNode, projectWorkflow } from "./editor.ts";
import { editCanvas, type CanvasKind } from "./canvas.ts";
import type { ExecutionGraph } from "./durable/run-graph.ts";

export interface EditorOptions {
  /** Inject a read-only observer from the OWNER of an existing native Harness.
   * Never open a second task scheduler merely to serve editor requests. */
  runGraph?: (nativeRunId: number) => Promise<ExecutionGraph | null>;
}

export async function readPackage(folder: string): Promise<WorkflowFiles> {
  const read = (name: string) => readFile(join(folder, name), "utf8");
  const [source, manifestJson, layoutJson] = await Promise.all([
    read("workflow.ts"), read("workflow.json"),
    read("layout.json").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  return { source, manifestJson, ...(layoutJson === undefined ? {} : { layoutJson }) };
}

async function persist(folder: string, expected: WorkflowFiles, next: WorkflowFiles): Promise<boolean> {
  const onDisk = await readPackage(folder);
  if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
    throw new Error("files on disk changed since load; reload before saving (nothing was overwritten)");
  }
  if (JSON.stringify(onDisk) === JSON.stringify(next)) return false;
  const originals: Record<string, string | undefined> = {
    "workflow.ts": onDisk.source,
    "workflow.json": onDisk.manifestJson,
    "layout.json": onDisk.layoutJson,
  };
  const targets: Record<string, string | undefined> = {
    "workflow.ts": next.source, "workflow.json": next.manifestJson, "layout.json": next.layoutJson,
  };
  const changed = Object.keys(targets).filter(name => originals[name] !== targets[name]);
  const staged: string[] = [];
  const replaced: string[] = [];
  try {
    for (const name of changed) {
      const temp = join(folder, "." + name + "." + randomUUID() + ".tmp");
      await writeFile(temp, targets[name]!, { encoding: "utf8", flag: "wx" });
      staged.push(temp);
    }
    for (let i = 0; i < changed.length; i++) {
      await rename(staged[i]!, join(folder, changed[i]!));
      replaced.push(changed[i]!);
    }
  } catch (cause) {
    for (const name of replaced.reverse()) {
      const previous = originals[name];
      if (previous === undefined) await rm(join(folder, name), { force: true });
      else await writeFile(join(folder, name), previous, "utf8");
    }
    throw cause;
  } finally {
    await Promise.all(staged.map(path => rm(path, { force: true })));
  }
  return true;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json") ||
      request.headers["x-workflow-editor"] !== "1") {
    throw new Error("expected application/json and X-Workflow-Editor: 1");
  }
  // Fatal streaming decoding retains split multibyte characters and rejects
  // malformed UTF-8 instead of quietly inserting replacement characters.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = "";
  let bytes = 0;
  for await (const part of request) {
    const chunk = part as Buffer;
    bytes += chunk.byteLength;
    if (bytes > 2_000_000) throw new Error("request too large (limit 2MB)");
    value += decoder.decode(chunk, { stream: true });
  }
  value += decoder.decode();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid action object");
  return parsed as Record<string, unknown>;
}

export async function startEditor(folder: string, port = 4175, options: EditorOptions = {}) {
  const directory = resolve(folder);
  const initial = await readPackage(directory);
  let workflow: LoadedWorkflow = await loadWorkflow(initial);
  let saved: WorkflowFiles = initial;
  let revision = 0;
  // All state transitions, including revision checks and disk saves, are serialized.
  // A rejected action does not poison the queue for subsequent requests.
  let actionTail: Promise<void> = Promise.resolve();
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const running = actionTail.then(action);
    actionTail = running.then(() => undefined, () => undefined);
    return running;
  }
  const publicFiles: Record<string, [string, string]> = {
    "/": ["../ui/index.html", "text/html; charset=utf-8"],
    "/app.js": ["../ui/app.js", "text/javascript; charset=utf-8"],
    "/source-text.js": ["../ui/source-text.js", "text/javascript; charset=utf-8"],
    "/style.css": ["../ui/style.css", "text/css; charset=utf-8"],
  };
  const server = createServer(async (request, response) => {
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      // This service must not be exposed on a public or LAN interface.
      const boundAddress = server.address();
      const activePort = boundAddress && typeof boundAddress !== "string" ? boundAddress.port : port;
      const host = String(request.headers.host ?? "");
      if (!new RegExp("^(localhost|127\\.0\\.0\\.1):" + activePort + "$").test(host)) {
        json(response, 403, { error: "localhost only" }); return;
      }
      const url = new URL(request.url ?? "/", "http://localhost:" + activePort);
      if (request.method === "GET" && url.pathname === "/api/state") {
        await enqueue(async () => {
          const snapshot = workflow;
          const files = exportWorkflow(snapshot);
          const graph = await projectWorkflow(snapshot);
          json(response, 200, {
            revision, dirty: JSON.stringify(files) !== JSON.stringify(saved),
            files, graph,
          });
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/run-graph") {
        if (!options.runGraph) {
          json(response, 503, { error: "Live inspection requires a native Pi Durable host connection." });
          return;
        }
        const raw = url.searchParams.get("runId");
        if (!raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          json(response, 400, { error: "runId must be a positive native task ID" });
          return;
        }
        const execution = await options.runGraph(Number(raw));
        // Never present another workflow's task graph inside the selected editor.
        if (!execution || execution.workflowId !== workflow.manifest.id) {
          json(response, 404, { error: "No matching native workflow run" });
          return;
        }
        json(response, 200, execution);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/action") {
        const origin = request.headers.origin;
        if (origin && origin !== "http://localhost:" + activePort && origin !== "http://127.0.0.1:" + activePort) {
          json(response, 403, { error: "cross-origin changes are forbidden" }); return;
        }
        const action = await body(request);
        await enqueue(async () => {
          // Verify *inside* the serialized section, after earlier edits/saves.
          if (action.revision !== revision) {
            json(response, 409, { error: "stale editor revision; reload" });
            return;
          }
          let pending = workflow;
          let nextSaved = saved;
          switch (action.type) {
            case "move":
              if (typeof action.id !== "string") throw new Error("missing node id");
              pending = await moveProjectedNode(workflow, action.id, action.x as number, action.y as number);
              break;
            case "property":
              if (typeof action.id !== "string") throw new Error("missing node id");
              pending = action.id.startsWith("canvas_")
                ? await editCanvas(workflow, { type: "rename-step", id: action.id, name: action.value as string })
                : await editKnownName(workflow, action.id, action.value as string);
              break;
            case "add-step":
              pending = await editCanvas(workflow, { type: "add-step", kind: action.kind as CanvasKind,
                name: action.name as string, x: action.x as number, y: action.y as number });
              break;
            case "remove-step":
              pending = await editCanvas(workflow, { type: "remove-step", id: action.id as string });
              break;
            case "connect-step":
              pending = await editCanvas(workflow, { type: "connect-step",
                from: action.from as string, to: action.to as string });
              break;
            case "code":
              pending = await editCode(workflow, action.source as string);
              break;
            case "save":
              await persist(directory, saved, exportWorkflow(workflow));
              nextSaved = exportWorkflow(workflow);
              break;
            case "reload":
              pending = await loadWorkflow(await readPackage(directory));
              nextSaved = exportWorkflow(pending);
              break;
            default: throw new Error("unknown editor action");
          }
          const graph = await projectWorkflow(pending);
          const files = exportWorkflow(pending);
          workflow = pending;
          saved = nextSaved;
          revision++;
          json(response, 200, {
            revision, dirty: JSON.stringify(files) !== JSON.stringify(saved),
            files, graph,
          });
        });
        return;
      }
      const asset = publicFiles[url.pathname];
      if (request.method === "GET" && asset) {
        const data = await readFile(fileURLToPath(new URL(asset[0], import.meta.url)));
        response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
        response.end(data);
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((ok, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", ok);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workflowIndex = process.argv.indexOf("--workflow");
  const portIndex = process.argv.indexOf("--port");
  const folder = workflowIndex >= 0 ? process.argv[workflowIndex + 1] : "./fixtures/complex";
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4175;
  if (!folder || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("usage: npm run editor -- --workflow PATH [--port 4175]");
  }
  startEditor(folder, port).then(() => {
    console.log("Workflow editor: http://localhost:" + port + " (package: " + resolve(folder) + ")");
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
