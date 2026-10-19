import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareCodeExecutor, sha256 } from "./code-executor.mjs";
import smoke from "./smoke-worker.mjs";

const SOURCE = "export default (input) => input.values.length;";

async function fixture() {
  const calls = [];
  const digest = await sha256(SOURCE);
  const approvals = new Map([["approved-1", digest]]);
  const loader = {
    get(id, callback) {
      const entry = { id, callback };
      calls.push(entry);
      return {
        getEntrypoint() {
          return {
            async fetch(request) {
              entry.request = request;
              return Response.json({ result: 3 }); // Stub: never evals supplied code.
            },
          };
        },
      };
    },
  };
  const executor = await createCloudflareCodeExecutor({ loader,
    authorize: async unit => approvals.get(unit.authorizationId) === unit.sourceSha256,
  });
  return { calls, approvals, loader, executor, unit: { source: SOURCE, sourceSha256: digest, authorizationId: "approved-1" } };
}

test("authorized unit uses optional loader with locked-down egress and resource limits", async () => {
  const f = await fixture();
  const result = await f.executor.execute(f.unit, { values: [2, 3, 4] });
  assert.equal(result, 3);
  assert.equal(f.calls.length, 1);
  const config = await f.calls[0].callback();
  assert.equal(config.globalOutbound, null);
  assert.deepEqual(config.env, {});
  assert.deepEqual(config.limits, { cpuMs: 50, subRequests: 1 });
  assert.equal(config.mainModule, "runner.js");
  assert.equal(config.modules["unit.js"], SOURCE);
  assert.ok(!config.modules["runner.js"].includes(SOURCE));
  assert.deepEqual(await f.calls[0].request.json(), { values: [2, 3, 4] });
  assert.deepEqual(f.executor.descriptor.capabilities, ["dynamic_code"]);
  assert.match(f.executor.descriptor.implementationSha256, /^[0-9a-f]{64}$/);
});

test("source digest mismatch, revoked authority and invalid unit fail before loading", async () => {
  const f = await fixture();
  await assert.rejects(f.executor.execute({ ...f.unit, source: SOURCE + "// edited" }, {}), /integrity/);
  f.approvals.clear();
  await assert.rejects(f.executor.execute(f.unit, {}), /not authorized/);
  await assert.rejects(f.executor.execute({ ...f.unit, authorizationId: "" }, {}), /Invalid approved/);
  assert.equal(f.calls.length, 0);
});

test("identical code reuses identity; modified code gets a different ID", async () => {
  const f = await fixture();
  await f.executor.execute(f.unit, {});
  await f.executor.execute(f.unit, {});
  assert.equal(f.calls[0].id, f.calls[1].id);
  const different = "export default () => 999;";
  const sourceSha256 = await sha256(different);
  f.approvals.set("approved-2", sourceSha256);
  await f.executor.execute({ source: different, sourceSha256, authorizationId: "approved-2" }, {});
  assert.notEqual(f.calls[0].id, f.calls[2].id);
});

test("oversized inputs and outputs are rejected; no stack or secret crosses response", async () => {
  const f = await fixture();
  await assert.rejects(f.executor.execute(f.unit, { text: "x".repeat(20_000) }), /input exceeds/);
  assert.equal(f.calls.length, 0);
  const loader = { get: () => ({ getEntrypoint: () => ({ fetch: async () =>
    new Response("x".repeat(20_000)) }) }) };
  const oversized = await createCloudflareCodeExecutor({ loader, authorize: async () => true });
  await assert.rejects(oversized.execute(f.unit, {}), /response exceeds/);
  const failed = await createCloudflareCodeExecutor({
    loader: { get: () => ({ getEntrypoint: () => ({ fetch: async () =>
      Response.json({ error: "hidden stack: key=secret" }, { status: 422 }) }) }) },
    authorize: async () => true,
  });
  await assert.rejects(failed.execute(f.unit, {}), e => {
    assert.equal(e.message, "Sandbox execution failed (HTTP 422)");
    return true;
  });
});

test("fixed smoke endpoint does not accept uploaded source or input", async () => {
  const f = await fixture();
  assert.equal((await smoke.fetch(new Request("https://example.invalid/execute", { method: "POST" }), { LOADER: f.loader })).status, 404);
  const response = await smoke.fetch(new Request("https://example.invalid/smoke"), { LOADER: f.loader });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: 3 }); // Stub proof only; not Cloudflare sandbox execution.
  assert.equal(f.calls.length, 1);
});
