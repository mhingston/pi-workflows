/**
 * Execution-provider contracts. A visual graph never chooses or rewrites a
 * backend: the source package states requirements and negotiation fails closed.
 */
import type { LoadedWorkflow } from "./artifact.ts";
import type { PublishedWorkflow } from "./publication.ts";

export const STANDARD_CAPABILITIES = [
  "agent", "hooks", "approval", "dynamic_tasks", "native_child_tasks",
  "timers", "signals", "dynamic_code", "durable_replay",
] as const;
export type StandardCapability = (typeof STANDARD_CAPABILITIES)[number];
/** Explicit escape hatch; never implied by a generic visual node. */
export type Capability = StandardCapability | `provider_${string}`;

export interface ProviderDescriptor {
  readonly id: string;
  readonly version: string;
  /** Fingerprint of the selected adapter implementation, not a runtime API promise. */
  readonly implementationSha256: string;
  readonly capabilities: readonly Capability[];
}

export interface StartRequest {
  readonly publication: PublishedWorkflow;
  readonly input: unknown;
  readonly interactiveApproval: "approved" | "not_required";
}

export interface WorkflowRuntime<Result = unknown> {
  readonly descriptor: ProviderDescriptor;
  /** Native runtime owns execution, tasks, state and recovery. */
  start(request: StartRequest): Promise<Result>;
}

export interface ApprovedCodeUnit {
  readonly source: string;
  readonly sourceSha256: string;
  /** Authorization is checked by the executor; this value alone grants nothing. */
  readonly authorizationId: string;
}
export interface CodeExecutor {
  readonly descriptor: ProviderDescriptor;
  execute(unit: ApprovedCodeUnit, input: unknown): Promise<unknown>;
}

export interface WorkflowStorage {
  publish(artifact: LoadedWorkflow, binding: PublicationBinding): Promise<PublishedWorkflow>;
  get(revisionId: string): Promise<PublishedWorkflow>;
}

export interface PublicationBinding {
  readonly runtime: ProviderDescriptor;
  readonly codeExecutor?: ProviderDescriptor;
  /** Actual exact installed versions; must match the declared manifest pins. */
  readonly resolvedDependencies: Readonly<Record<string, string>>;
}

const KNOWN = new Set<string>(STANDARD_CAPABILITIES);
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function validateDescriptor(provider: ProviderDescriptor): void {
  if (!IDENTIFIER.test(provider.id) || !VERSION.test(provider.version) ||
      !SHA.test(provider.implementationSha256) || !Array.isArray(provider.capabilities)) {
    throw new CapabilityError("Invalid provider identity or version/implementation fingerprint");
  }
  const seen = new Set<string>();
  for (const capability of provider.capabilities) {
    if (typeof capability !== "string" ||
        (!KNOWN.has(capability) && !capability.startsWith("provider_" + provider.id + "_"))) {
      throw new CapabilityError("Invalid or foreign provider capability: " + String(capability));
    }
    if (seen.has(capability)) throw new CapabilityError("Duplicate provider capability: " + capability);
    seen.add(capability);
  }
}

/** All requirements must be understood and explicitly supported. No fallback. */
export function requireCapabilities(provider: ProviderDescriptor, required: readonly string[]): void {
  validateDescriptor(provider);
  const missing = required.filter(capability =>
    (!KNOWN.has(capability) && !capability.startsWith("provider_" + provider.id + "_")) ||
    !provider.capabilities.includes(capability as Capability));
  if (missing.length) {
    throw new CapabilityError("Unsupported runtime capabilities: " + missing.join(", "));
  }
}

/** Runtime and code-execution implementations are separate registries. */
export class ProviderRegistry {
  private readonly runtimes = new Map<string, WorkflowRuntime>();
  private readonly executors = new Map<string, CodeExecutor>();

  registerRuntime(runtime: WorkflowRuntime): void {
    validateDescriptor(runtime.descriptor);
    if (this.runtimes.has(runtime.descriptor.id)) {
      throw new CapabilityError("Duplicate runtime provider: " + runtime.descriptor.id);
    }
    this.runtimes.set(runtime.descriptor.id, runtime);
  }

  registerExecutor(executor: CodeExecutor): void {
    validateDescriptor(executor.descriptor);
    if (this.executors.has(executor.descriptor.id)) {
      throw new CapabilityError("Duplicate code executor: " + executor.descriptor.id);
    }
    this.executors.set(executor.descriptor.id, executor);
  }

  runtime(id: string, requirements: readonly string[]): WorkflowRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new CapabilityError("Unknown runtime provider: " + id);
    requireCapabilities(runtime.descriptor, requirements);
    return runtime;
  }

  executor(id: string, requirements: readonly string[]): CodeExecutor {
    const executor = this.executors.get(id);
    if (!executor) throw new CapabilityError("Unknown code executor: " + id);
    requireCapabilities(executor.descriptor, requirements);
    return executor;
  }
}
