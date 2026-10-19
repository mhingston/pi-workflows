/**
 * Immutable, content-addressed workflow publications. A revision contains the
 * original source and manifest bytes, the resolved dependency lock and exact
 * execution implementation identity. Reading always re-verifies the digest.
 *
 * This local filesystem store is not a tamper-proof signing service; it is an
 * immutable API with corruption detection. No source code is executed here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { exportWorkflow, loadWorkflow, sha256, type LoadedWorkflow, type WorkflowFiles } from "./artifact.ts";
import { requireCapabilities, validateDescriptor, type PublicationBinding, type WorkflowStorage } from "./providers.ts";

const SHA = /^[a-f0-9]{64}$/;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class PublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationError";
  }
}

export interface PublishedWorkflow {
  readonly revisionId: string;
  readonly artifact: LoadedWorkflow;
  readonly binding: PublicationBinding;
}
interface PublishedBody {
  readonly schemaVersion: 1;
  readonly files: WorkflowFiles;
  readonly binding: PublicationBinding;
}
interface PublishedRecord extends PublishedBody {
  readonly revisionId: string;
}

function checkBinding(artifact: LoadedWorkflow, binding: PublicationBinding): void {
  validateDescriptor(binding.runtime);
  requireCapabilities(binding.runtime, artifact.manifest.requiredCapabilities);
  if (binding.codeExecutor) validateDescriptor(binding.codeExecutor);
  if (artifact.manifest.requiredCapabilities.includes("dynamic_code") && !binding.codeExecutor) {
    throw new PublicationError("Dynamic code requires an explicitly selected code executor");
  }
  const declared = artifact.manifest.dependencies;
  const actual = binding.resolvedDependencies;
  if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
      !isDeepStrictEqual(Object.keys(declared).sort(), Object.keys(actual).sort())) {
    throw new PublicationError("Every declared dependency must have one resolved version");
  }
  for (const [name, version] of Object.entries(declared)) {
    if (!EXACT_VERSION.test(version) || actual[name] !== version) {
      throw new PublicationError("Dependency is not an exact, installed pin: " + name);
    }
  }
}

function copyBinding(binding: PublicationBinding): PublicationBinding {
  return {
    runtime: { ...binding.runtime, capabilities: [...binding.runtime.capabilities] },
    ...(binding.codeExecutor ? { codeExecutor: {
      ...binding.codeExecutor, capabilities: [...binding.codeExecutor.capabilities],
    } } : {}),
    resolvedDependencies: { ...binding.resolvedDependencies },
  };
}

export class FilePublicationStore implements WorkflowStorage {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  private filename(id: string): string {
    if (!SHA.test(id)) throw new PublicationError("Invalid publication revision ID");
    return join(this.directory, id + ".json");
  }

  async publish(artifact: LoadedWorkflow, binding: PublicationBinding): Promise<PublishedWorkflow> {
    // Recheck callers' mutable objects and exact original byte strings.
    const validated = await loadWorkflow(exportWorkflow(artifact));
    checkBinding(validated, binding);
    const body: PublishedBody = {
      schemaVersion: 1, files: exportWorkflow(validated), binding: copyBinding(binding),
    };
    const revisionId = await sha256(JSON.stringify(body));
    const record: PublishedRecord = { ...body, revisionId };
    const path = this.filename(revisionId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Also detects corrupt or incomplete existing publications.
    const existing = await this.get(revisionId);
    if (!isDeepStrictEqual(exportWorkflow(existing.artifact), body.files) ||
        !isDeepStrictEqual(existing.binding, body.binding)) {
      throw new PublicationError("Published revision contents differ from expected immutable snapshot");
    }
    return existing;
  }

  async get(revisionId: string): Promise<PublishedWorkflow> {
    const raw = await readFile(this.filename(revisionId), "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new PublicationError("Corrupt published revision JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PublicationError("Invalid published revision");
    }
    const record = parsed as Record<string, unknown>;
    if (!isDeepStrictEqual(Object.keys(record).sort(),
      ["revisionId", "schemaVersion", "files", "binding"].sort()) ||
      record.revisionId !== revisionId || record.schemaVersion !== 1) {
      throw new PublicationError("Invalid published revision envelope");
    }
    const body = {
      schemaVersion: record.schemaVersion, files: record.files, binding: record.binding,
    };
    if (await sha256(JSON.stringify(body)) !== revisionId) {
      throw new PublicationError("Published revision content hash mismatch");
    }
    const files = body.files as WorkflowFiles;
    const artifact = await loadWorkflow(files);
    const binding = body.binding as PublicationBinding;
    checkBinding(artifact, binding);
    return { revisionId, artifact, binding };
  }
}
