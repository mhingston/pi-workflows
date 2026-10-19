/**
 * Immutable, content-addressed workflow publications. A revision contains the
 * original source and manifest bytes, the resolved dependency lock and exact
 * execution implementation identity. Reading always re-verifies the digest.
 *
 * This local filesystem store is not a tamper-proof signing service; it is an
 * immutable API with corruption detection. No source code is executed here.
 */
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  if (artifact.manifest.requiredCapabilities.includes("dynamic_code")) {
    if (!binding.codeExecutor) {
      throw new PublicationError("Dynamic code requires an explicitly selected code executor");
    }
    // A well-formed descriptor is not evidence that the executor implements
    // the operation. Validate support on the executor, not only the runtime.
    requireCapabilities(binding.codeExecutor, ["dynamic_code"]);
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
    // Write the complete revision under a unique name first, then atomically
    // install it with a hard link in the SAME directory. Unlike rename(), link()
    // cannot replace a published revision; concurrent publishers are safe and
    // readers never observe a partially written destination.
    const temporaryPath = join(this.directory, "." + revisionId + "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      // A crash may leave an orphaned .tmp file, but cannot expose a partial
      // published revision. Re-publishing remains possible.
      await unlink(temporaryPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    // Also detects corruption in a previously installed publication.
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
