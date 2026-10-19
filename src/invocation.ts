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
import { loadWorkflow, sha256, type LoadedWorkflow } from "./artifact.ts";
import { FilePublicationStore, type PublishedWorkflow } from "./publication.ts";
import {
  ProviderRegistry, type Capability, type ProviderDescriptor, type WorkflowRuntime,
} from "./providers.ts";
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
  /** Publish the trusted package and return its immutable revision ID. */
  publish(name: string): Promise<string>;
  run(name: string, input: unknown, options?: RunOptions): Promise<WorkflowInvocationResult>;
  /** Run a particular content-addressed revision, never the current draft. */
  runRevision(revisionId: string, input: unknown, options?: RunOptions): Promise<WorkflowInvocationResult>;
}
export interface InvocationConfig {
  cwd: string;
  home?: string;
  dbPath?: string;
  capabilities?: readonly Capability[];
  /** Only pi_durable is registered for execution in this slice. */
  runtimeId?: string;
  publicationDir?: string;
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
  const capabilities = config.capabilities ??
    [...FIXTURE_CAPABILITIES, "native_child_tasks", "timers", "durable_replay",
      "provider_pi_durable_native_tasks"] as readonly Capability[];
  const publications = new FilePublicationStore(config.publicationDir ??
    join(config.cwd, ".pi", "workflow-publications"));
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

  async function resolvedBinding(): Promise<{ descriptor: ProviderDescriptor; dependencies: Record<string, string> }> {
    // Pin the adapter source *and* installed runtime version, not just a
    // user-declared package range. This bounded adapter uses one known package.
    const [implementation, adapterSource, dependencyJson] = await Promise.all([
      readFile(new URL("./durable/fixture-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("./invocation.ts", import.meta.url), "utf8"),
      readFile(new URL("../node_modules/@earendil-works/pi-durable/package.json", import.meta.url), "utf8"),
    ]);
    const installed = JSON.parse(dependencyJson) as { version?: unknown };
    if (typeof installed.version !== "string") {
      throw new WorkflowInvocationError("dependency_lock", "Installed Pi Durable version is unknown.");
    }
    const descriptor: ProviderDescriptor = {
      id: "pi_durable", version: installed.version,
      implementationSha256: await sha256(implementation + "\\0" + adapterSource),
      capabilities,
    };
    return { descriptor, dependencies: { "@earendil-works/pi-durable": installed.version } };
  }

  function registeredRuntime(descriptor: ProviderDescriptor): WorkflowRuntime<WorkflowInvocationResult> {
    const effect: ApprovalEffect = config.fixtureEffect ?? { approve: async () => true };
    return {
      descriptor,
      async start(request) {
        const publication = request.publication;
        // File contents are rechecked immediately before starting any task.
        const current = await publications.get(publication.revisionId);
        if (!isDeepStrictEqual(current.binding.runtime, descriptor)) {
          throw new WorkflowInvocationError("runtime_drift", "Published runtime implementation changed; refusing to run.");
        }
        const expected = {
          revisionId: current.revisionId,
          runtime: current.binding.runtime,
          dependencies: current.binding.resolvedDependencies,
          configurationSha256: await sha256(JSON.stringify({
            effectPolicy: "intent_receipt_manual_reconciliation",
            approvalPort: config.fixtureEffect ? "injected_fixture" : "trusted_fixture_noop",
          })),
        };
        const fixture = registerFixtureWorkflow(current.artifact, effect, expected);
        // The fixture persists this exact field order when creating RunInput.
        // Never hash caller object insertion order: both Pi invocation paths may
        // receive equivalent JSON with different property ordering.
        const typed = request.input as WorkflowInput;
        const persistedInput: WorkflowInput = {
          values: typed.values, requiresApproval: typed.requiresApproval,
        };
        const pin = { ...expected, inputSha256: await sha256(JSON.stringify(persistedInput)) };
        await mkdir(dirname(dbPath), { recursive: true });
        const ctx = BACKGROUND_CONTEXT;
        const harness = await Harness.open(await openNodeSqliteStorage(dbPath),
          { models: createModels(), registry: fixture.registry }, ctx);
        try {
          const root = await harness.root(ctx);
          const id = await root.commit(tx => tx.createTask(fixture.Run,
            fixture.input(typed.values, typed.requiresApproval,
              request.interactiveApproval === "approved" ? "approved" : undefined, pin),
            { ownership: { kind: "conversation" } }), ctx);
          const settled = await harness.waitForTask(id, ctx);
          const outcome = settled.state.outcome;
          if (outcome.status === "completed") {
            if (outcome.result.status === "needs_reconciliation") {
              return { status: "needs_reconciliation", runId: Number(id), effectKey: outcome.result.effectKey };
            }
            return { status: "completed", runId: Number(id), output: outcome.result.output };
          }
          return { status: "failed", runId: Number(id),
            error: "Native workflow task did not complete successfully." };
        } finally {
          await harness.close(ctx);
        }
      },
    };
  }

  async function selectRuntime(artifact: LoadedWorkflow) {
    const { descriptor, dependencies } = await resolvedBinding();
    const registry = new ProviderRegistry();
    registry.registerRuntime(registeredRuntime(descriptor));
    const runtime = registry.runtime(config.runtimeId ?? "pi_durable", artifact.manifest.requiredCapabilities) as WorkflowRuntime<WorkflowInvocationResult>;
    return { runtime, dependencies };
  }

  async function publishArtifact(artifact: LoadedWorkflow) {
    const { runtime, dependencies } = await selectRuntime(artifact);
    return publications.publish(artifact, {
      runtime: runtime.descriptor, resolvedDependencies: dependencies,
    });
  }

  async function trustedEntry(name: string): Promise<LoadedWorkflow> {
    const { entries, trusted } = await catalog();
    const entry = entries.find(entry => entry.name === name);
    if (!entry) throw new WorkflowInvocationError("unknown_workflow", 'Unknown workflow "' + name + '".');
    if (!allowed(entry, trusted)) {
      throw new WorkflowInvocationError("untrusted_workflow",
        'Workflow "' + name + '" is untrusted, invalid or does not match its registered revision.');
    }
    return entry.artifact;
  }

  async function execute(publication: PublishedWorkflow, input: unknown,
    options: RunOptions): Promise<WorkflowInvocationResult> {
    const trusted = await packageFrom(packaged);
    if (!allowed({ name: publication.artifact.manifest.id, artifact: publication.artifact, path: "" }, trusted)) {
      throw new WorkflowInvocationError("untrusted_workflow",
        "Published source does not match the registered trusted module.");
    }
    const { runtime, dependencies } = await selectRuntime(publication.artifact);
    if (!isDeepStrictEqual(publication.binding.runtime, runtime.descriptor) ||
        !isDeepStrictEqual(publication.binding.resolvedDependencies, dependencies)) {
      throw new WorkflowInvocationError("runtime_drift",
        "Published dependencies or runtime implementation changed; refusing to run.");
    }
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(publication.artifact.manifest.inputSchema);
    if (!validate(input)) {
      throw new WorkflowInvocationError("invalid_input",
        "Invalid workflow input: " + (validate.errors ?? []).map(e => e.instancePath || e.schemaPath).join(", "));
    }
    const typed = input as WorkflowInput;
    if (typed.requiresApproval && (!options.authorize ||
        !await options.authorize(publication.artifact.manifest.id))) {
      throw new WorkflowInvocationError("approval_required", "Workflow action was not explicitly approved.");
    }
    return runtime.start({
      publication, input: typed,
      interactiveApproval: typed.requiresApproval ? "approved" : "not_required",
    });
  }

  async function invoke(name: string, input: unknown, options: RunOptions): Promise<WorkflowInvocationResult> {
    const artifact = await trustedEntry(name);
    // Negotiation/publishing precedes execution; rejecting inputs/approval also
    // prevents native task creation. Publications are immutable and reverified.
    const publication = await publishArtifact(artifact);
    return execute(publication, input, options);
  }

  async function invokeRevision(revisionId: string, input: unknown,
    options: RunOptions): Promise<WorkflowInvocationResult> {
    return execute(await publications.get(revisionId), input, options);
  }

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const scheduled = tail.then(work);
    tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  return {
    list,
    publish: name => serialized(async () => (await publishArtifact(await trustedEntry(name))).revisionId),
    run: (name, input, options = {}) => serialized(() => invoke(name, input, options)),
    runRevision: (revisionId, input, options = {}) =>
      serialized(() => invokeRevision(revisionId, input, options)),
  };
}
