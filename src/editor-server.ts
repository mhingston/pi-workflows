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
  let value = "";
  for await (const part of request) {
    value += part.toString("utf8");
    if (value.length > 2_000_000) throw new Error("request too large (limit 2MB)");
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid action object");
  return parsed as Record<string, unknown>;
}

export async function startEditor(folder: string, port = 4175) {
  const directory = resolve(folder);
  const initial = await readPackage(directory);
  let workflow: LoadedWorkflow = await loadWorkflow(initial);
  let saved: WorkflowFiles = initial;
  let revision = 0;
  const publicFiles: Record<string, [string, string]> = {
    "/": ["../ui/index.html", "text/html; charset=utf-8"],
    "/app.js": ["../ui/app.js", "text/javascript; charset=utf-8"],
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
        json(response, 200, {
          revision, dirty: JSON.stringify(exportWorkflow(workflow)) !== JSON.stringify(saved),
          files: exportWorkflow(workflow), graph: await projectWorkflow(workflow),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/action") {
        const origin = request.headers.origin;
        if (origin && origin !== "http://localhost:" + activePort && origin !== "http://127.0.0.1:" + activePort) {
          json(response, 403, { error: "cross-origin changes are forbidden" }); return;
        }
        const action = await body(request);
        if (action.revision !== revision) { json(response, 409, { error: "stale editor revision; reload" }); return; }
        let pending = workflow;
        switch (action.type) {
          case "move":
            if (typeof action.id !== "string") throw new Error("missing node id");
            pending = await moveProjectedNode(workflow, action.id, action.x as number, action.y as number);
            break;
          case "property":
            if (typeof action.id !== "string") throw new Error("missing node id");
            pending = await editKnownName(workflow, action.id, action.value as string);
            break;
          case "code":
            pending = await editCode(workflow, action.source as string);
            break;
          case "save":
            await persist(directory, saved, exportWorkflow(workflow));
            saved = exportWorkflow(workflow);
            break;
          case "reload":
            pending = await loadWorkflow(await readPackage(directory));
            break;
          default: throw new Error("unknown editor action");
        }
        // Reject stale AST identities before changing in-memory state.
        await projectWorkflow(pending);
        workflow = pending;
        if (action.type === "reload") saved = exportWorkflow(workflow);
        revision++;
        json(response, 200, {
          revision, dirty: JSON.stringify(exportWorkflow(workflow)) !== JSON.stringify(saved),
          files: exportWorkflow(workflow), graph: await projectWorkflow(workflow),
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
