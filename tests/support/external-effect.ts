/**
 * Simulates an external service that honours idempotency keys.
 * Its atomic receipt file is the *external effect* itself, not a second
 * workflow scheduler or an extra store for Pi Durable task state.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectPort, EffectAttempt } from "../../fixtures/durable/workflow.ts";

export class FileEffectPort implements EffectPort {
  private readonly directory: string;
  readonly afterApply?: (result: EffectAttempt) => Promise<void>;

  constructor(directory: string, afterApply?: (result: EffectAttempt) => Promise<void>) {
    this.directory = directory;
    this.afterApply = afterApply;
  }

  static keyPath(directory: string, key: string): string {
    const digest = createHash("sha256").update(key, "utf8").digest("hex");
    return join(directory, "effect-" + digest + ".json");
  }

  async apply(key: string, amount: number): Promise<EffectAttempt> {
    await mkdir(this.directory, { recursive: true });
    await appendFile(join(this.directory, "attempts.txt"), key + "\n", "utf8");
    const path = FileEffectPort.keyPath(this.directory, key);
    const payload = JSON.stringify({ key, amount });
    try {
      // O_EXCL: durable receipt and effect occur as one atomic external
      // provider operation. Replays with this key must never apply twice.
      await writeFile(path, payload, { flag: "wx" });
      return "applied";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "uncertain";
      try {
        const previous = await readFile(path, "utf8");
        // A key collision with a different payload is not a successful retry.
        return previous === payload ? "already_applied" : "uncertain";
      } catch {
        return "uncertain";
      }
    }
  }
}
