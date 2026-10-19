/**
 * Shared, trusted workflow invocation. Manifests are DATA, never import targets.
 * Only the checked-in dynamic_agents code is registered into native Pi Durable.
 */
import { readFile, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadWorkflow, type LoadedWorkflow } from "./artifact.ts";
import { FIXTURE_CAPABILITIES, registerFixtureWorkflow, type ApprovalEffect } from "./durable/fixture-runtime.ts";
import type { WorkflowInput } from "../fixtures/complex/workflow.ts";

export interface WorkflowSummary {
  readonly name: string;
  readonly version: string;
  readonly requiredCapabilities: readonly string[];
}
export type WorkflowInvocationResult =
  | { status: "completed"; runId: number; output: number }
  | { status: "needs_reconciliation"; runId: number; effectKey: string }
  | { status: "failed"; runId: number; error: string };

export class WorkflowInvocationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkflowInvocationError";
  }
}

type RunOptions = {
  /** Called only after package, input and capability validation. */
  authorize?: (name: string) => Promise<boolean>;
};
export interface WorkflowInvocationService {
  list(): Promise<WorkflowSummary[]>;
  run(name: string, input: unknown, options?: RunOptions): Promise<WorkflowInvocationResult>;
}
export interface InvocationConfig {
  cwd: string;
  home?: string;
  dbPath?: string;
  capabilities?: readonly string[];
  /** Test-only injected effect. Production uses an approved no-op fixture port. */
  fixtureEffect?: ApprovalEffect;
  /** Do not inspect project packages without Pi's project-trust grant. */
  projectTrusted?: boolean;
}

type CatalogEntry = { name: string; artifact?: LoadedWorkflow; invalid?: boolean; path: string };
const packaged = new URL("../fixtures/complex/", import.meta.url);

async function packageFrom(directory: string | URL): Promise<LoadedWorkflow> {
  const path = typeof directory === "string" ? directory : fileURLToPath(directory);
  const [source, manifestJson] = await Promise.all([
    readFile(join(path, "workflow.ts"), "utf8"),
    readFile(join(path, "workflow.json"), "utf8"),
  ]);
  return loadWorkflow({ source, manifestJson });
}
async function discover(directory: string): Promise<CatalogEntry[]> {
  let names;
  try { names = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: CatalogEntry[] = [];
  for (const item of names.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, item.name);
    try {
      const artifact = await packageFrom(path);
      entries.push({ name: artifact.manifest.id, path, artifact });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Not a package.
      // Malformed packages cannot be executed or silently shadowed by the bundled workflow.
      entries.push({ name: item.name, path, invalid: true });
    }
  }
  return entries;
}
function unique(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new WorkflowInvocationError("duplicate_workflow",
        'Duplicate workflow name "' + entry.name + '"; remove the conflicting package.');
    }
    seen.add(entry.name);
  }
  return entries;
}

/** Keep one serialized SQLite harness owner per service; no separate scheduler. */
export function createWorkflowInvocationService(config: InvocationConfig): WorkflowInvocationService {
  const home = config.home ?? homedir();
  const capabilities = config.capabilities ?? FIXTURE_CAPABILITIES;
  const dbPath = config.dbPath ?? join(config.cwd, ".pi", "workflow-runs.sqlite");
  let tail: Promise<unknown> = Promise.resolve();

  async function catalog(): Promise<{ entries: CatalogEntry[]; trusted: LoadedWorkflow }> {
    const trusted = await packageFrom(packaged);
    if (trusted.manifest.id !== "dynamic_agents" || trusted.manifest.version !== "1.0.0") {
      throw new WorkflowInvocationError("trusted_package", "Unsupported installed trusted fixture revision.");
    }
    const roots = [...new Set([
      ...(config.projectTrusted === false ? [] : [join(config.cwd, ".pi", "workflows")]),
      join(home, ".pi", "workflows"),
    ])];
    const entries = (await Promise.all(roots.map(discover))).flat();
    if (!entries.some(item => item.name === trusted.manifest.id)) {
      entries.push({ name: trusted.manifest.id, path: fileURLToPath(packaged), artifact: trusted });
    }
    return { entries: unique(entries), trusted };
  }
  function allowed(entry: CatalogEntry, trusted: LoadedWorkflow): entry is CatalogEntry & { artifact: LoadedWorkflow } {
    return !!entry.artifact && entry.artifact.source === trusted.source &&
      isDeepStrictEqual(entry.artifact.manifest, trusted.manifest);
  }
  const list = async (): Promise<WorkflowSummary[]> => {
    const { entries, trusted } = await catalog();
    return entries.filter(entry => allowed(entry, trusted)).map(entry => ({
      name: entry.artifact!.manifest.id,
      version: entry.artifact!.manifest.version,
      requiredCapabilities: entry.artifact!.manifest.requiredCapabilities,
    }));
  };

  async function invoke(name: string, input: unknown, options: RunOptions): Promise<WorkflowInvocationResult> {
    const { entries, trusted } = await catalog();
    const entry = entries.find(entry => entry.name === name);
    if (!entry) throw new WorkflowInvocationError("unknown_workflow", 'Unknown workflow "' + name + '".');
    if (!allowed(entry, trusted)) {
      throw new WorkflowInvocationError("untrusted_workflow",
        'Workflow "' + name + '" is untrusted, invalid or does not match its registered revision.');
    }
    const missing = entry.artifact.manifest.requiredCapabilities.filter(cap => !capabilities.includes(cap));
    if (missing.length) {
      throw new WorkflowInvocationError("unsupported_capabilities", "Unsupported runtime capabilities: " + missing.join(", "));
    }
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(entry.artifact.manifest.inputSchema);
    if (!validate(input)) {
      // Schema paths only: never echo supplied values (possibly sensitive).
      throw new WorkflowInvocationError("invalid_input",
        "Invalid workflow input: " + (validate.errors ?? []).map(e => e.instancePath || e.schemaPath).join(", "));
    }
    // The trusted schema provides the type-level contract, not a runtime TS import of source.
    const typed = input as WorkflowInput;
    if (typed.requiresApproval) {
      if (!options.authorize || !await options.authorize(name)) {
        throw new WorkflowInvocationError("approval_required", "Workflow action was not explicitly approved.");
      }
    }
    const effect: ApprovalEffect = config.fixtureEffect ?? { approve: async () => true };
    const fixture = registerFixtureWorkflow(entry.artifact, effect);
    await mkdir(dirname(dbPath), { recursive: true });
    const ctx = BACKGROUND_CONTEXT;
    const harness = await Harness.open(await openNodeSqliteStorage(dbPath),
      { models: createModels(), registry: fixture.registry }, ctx);
    try {
      const root = await harness.root(ctx);
      const id = await root.commit(tx => tx.createTask(fixture.Run,
        fixture.input(typed.values, typed.requiresApproval, typed.requiresApproval ? "approved" : undefined), { ownership: { kind: "conversation" } }), ctx);
      const settled = await harness.waitForTask(id, ctx);
      const outcome = settled.state.outcome;
      if (outcome.status === "completed") {
        if (outcome.result.status === "needs_reconciliation") {
          return { status: "needs_reconciliation", runId: Number(id), effectKey: outcome.result.effectKey };
        }
        return { status: "completed", runId: Number(id), output: outcome.result.output };
      }
      // Never return arbitrary task errors or input content to the model.
      return { status: "failed", runId: Number(id), error: "Native workflow task did not complete successfully." };
    } finally {
      await harness.close(ctx);
    }
  }

  return {
    list,
    run(name, input, options = {}) {
      // Both entry points share the same queue and native SQLite store.
      const work = tail.then(() => invoke(name, input, options));
      tail = work.then(() => undefined, () => undefined);
      return work;
    },
  };
}
