/** Optional, fixed-code Wrangler smoke, NOT a multi-tenant execution endpoint. */
import { createCloudflareCodeExecutor, sha256 } from "./code-executor.mjs";

const SOURCE = `export default function run(input) {
  return input.values.filter(value => value > 0).reduce((total, value) => total + value, 0);
}`;

export default {
  async fetch(request, env) {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/smoke") {
      return new Response("Not found", { status: 404 });
    }
    const approvedDigest = await sha256(SOURCE);
    const executor = await createCloudflareCodeExecutor({
      loader: env.LOADER,
      authorize: async unit => unit.authorizationId === "fixed-smoke" &&
        unit.sourceSha256 === approvedDigest,
    });
    const result = await executor.execute({
      source: SOURCE, sourceSha256: approvedDigest, authorizationId: "fixed-smoke",
    }, { values: [2, -3, 4] });
    return Response.json({ result });
  },
};
