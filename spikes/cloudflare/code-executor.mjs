/**
 * Issue #9 spike: structurally implements the CodeExecutor port in src/providers.ts.
 * This module is NOT registered by the normal Pi invocation service.
 * Only a Cloudflare Worker with a Worker Loader binding can execute the code.
 */
const COMPATIBILITY_DATE = "2026-10-12";
const MAX_SOURCE_BYTES = 8 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const CPU_MS = 50;
const SUBREQUESTS = 1;
const ENCODER = new TextEncoder();

// Imported as a distinct module: never interpolate user-controlled JS into the wrapper.
const RUNNER_SOURCE = `import run from "./unit.js";
export default {
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
      const result = await run(await request.json());
      const body = JSON.stringify({ result });
      if (typeof body !== "string" || new TextEncoder().encode(body).length > 16384) {
        return Response.json({ error: "output_limit" }, { status: 413 });
      }
      return new Response(body, { headers: { "content-type": "application/json" } });
    } catch {
      // Never forward user-code exceptions, traces or input in HTTP error bodies.
      return Response.json({ error: "execution_failed" }, { status: 422 });
    }
  },
};`;

export async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", ENCODER.encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_OUTPUT_BYTES) throw new Error("Sandbox response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(joined);
}

/**
 * @param {{ loader: { get: Function }, authorize: (unit: object) => Promise<boolean> }} options
 * @returns {Promise<import('../../src/providers.ts').CodeExecutor>}
 * The descriptor fingerprint is illustrative: a production provider must hash
 * the full deployed adapter implementation and pin it at publication time.
 */
export async function createCloudflareCodeExecutor({ loader, authorize }) {
  if (typeof loader?.get !== "function" || typeof authorize !== "function") {
    throw new TypeError("A Cloudflare Worker Loader and approval resolver are required");
  }
  const policyId = await sha256(JSON.stringify({ RUNNER_SOURCE, COMPATIBILITY_DATE,
    MAX_SOURCE_BYTES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, CPU_MS, SUBREQUESTS }));
  return {
    descriptor: {
      id: "cloudflare_dynamic_workers",
      version: "0.0.0-spike",
      implementationSha256: policyId,
      capabilities: ["dynamic_code"],
    },
    async execute(unit, input) {
      if (!unit || typeof unit.source !== "string" ||
          typeof unit.authorizationId !== "string" || !unit.authorizationId ||
          typeof unit.sourceSha256 !== "string" ||
          ENCODER.encode(unit.source).length > MAX_SOURCE_BYTES) {
        throw new Error("Invalid approved code unit");
      }
      if (await sha256(unit.source) !== unit.sourceSha256) {
        throw new Error("Code integrity check failed");
      }
      // Authorization must be resolved by trusted host policy, NOT by the unit itself.
      if (await authorize(unit) !== true) throw new Error("Code unit not authorized");
      const body = JSON.stringify(input);
      if (typeof body !== "string" || ENCODER.encode(body).length > MAX_INPUT_BYTES) {
        throw new Error("Sandbox input exceeds size limit or is not JSON serializable");
      }
      // Include wrapper/policy digest in ID; code and configuration must remain immutable.
      const workerId = `piw-${policyId}-${unit.sourceSha256}`;
      const worker = loader.get(workerId, async () => ({
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: "runner.js",
        modules: { "runner.js": RUNNER_SOURCE, "unit.js": unit.source },
        globalOutbound: null, // Cloudflare default is otherwise public network access.
        env: {}, // No parent secrets or service bindings reach the untrusted Worker.
        limits: { cpuMs: CPU_MS, subRequests: SUBREQUESTS },
      }));
      // This is an in-process Request handed to the WorkerStub, NOT a network fetch.
      const result = await worker.getEntrypoint().fetch(new Request("https://isolated.invalid/execute", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }));
      if (!result || typeof result.status !== "number") throw new Error("Invalid sandbox response");
      const text = await boundedText(result);
      if (!result.ok) throw new Error(`Sandbox execution failed (HTTP ${result.status})`);
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { throw new Error("Invalid sandbox response JSON"); }
      if (!parsed || !Object.hasOwn(parsed, "result")) throw new Error("Missing sandbox result");
      return parsed.result;
    },
  };
}
