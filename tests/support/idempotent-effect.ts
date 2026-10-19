/**
 * Test-only stand-in for an EXTERNAL provider, persisted outside Pi Durable's
 * SQLite database. A key is reserved with O_EXCL before being applied; a
 * duplicate sees the authoritative receipt rather than applying again.
 * A torn/missing/unreadable record is UNKNOWN, never a success.
 *
 * This models an atomic provider contract for a single, sequential test
 * caller. It is NOT a production transaction implementation.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ApprovalEffect, ApprovalRequest, ProviderApprovalResult } from "../../src/durable/fixture-runtime.ts";

export function receiptPath(directory: string, key: string): string {
  return join(directory, createHash("sha256").update(key).digest("hex") + ".json");
}

export function idempotentFileProvider(directory: string) {
  return {
    async applyIdempotently(idempotencyKey: string, request: ApprovalRequest): Promise<ProviderApprovalResult> {
      await mkdir(directory, { recursive: true });
      await appendFile(join(directory, "attempts.jsonl"), JSON.stringify({ idempotencyKey, request }) + "\n");
      const path = receiptPath(directory, idempotencyKey);
      let file;
      try {
        file = await open(path, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { status: "unknown" };
        try {
          const stored: unknown = JSON.parse(await readFile(path, "utf8"));
          if (!stored || typeof stored !== "object") return { status: "unknown" };
          const record = stored as Record<string, unknown>;
          if (typeof record.idempotencyKey !== "string" ||
              typeof record.approved !== "boolean" ||
              !record.request || typeof record.request !== "object") {
            return { status: "unknown" };
          }
          if (record.idempotencyKey !== idempotencyKey ||
              !isDeepStrictEqual(record.request, request)) return { status: "conflict" };
          return { status: "already_applied", idempotencyKey, request, approved: record.approved };
        } catch {
          return { status: "unknown" };
        }
      }
      try {
        await file.writeFile(JSON.stringify({ idempotencyKey, request, approved: true }));
        await file.sync();
      } catch {
        // The exclusive file may exist with incomplete contents; never claim
        // an applied receipt if persistence itself is uncertain.
        return { status: "unknown" };
      } finally {
        await file.close();
      }
      return { status: "applied", idempotencyKey, request, approved: true };
    },
  } satisfies ApprovalEffect;
}
