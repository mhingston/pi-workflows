/** Trusted fixture only. This is not a generic workflow code loader. */
import { readFile } from "node:fs/promises";
import { loadWorkflow, sha256 } from "../../src/artifact.ts";
import { registerFixtureWorkflow, type ApprovalEffect } from "../../src/durable/fixture-runtime.ts";

export async function trustedFixture(effect: ApprovalEffect) {
  const source = await readFile(new URL("../../fixtures/complex/workflow.ts", import.meta.url), "utf8");
  const artifact = await loadWorkflow({
    source,
    manifestJson: JSON.stringify({
      schemaVersion: 1,
      id: "dynamic_agents",
      version: "1.0.0",
      entrypoint: "workflow.ts",
      sourceSha256: await sha256(source),
      inputSchema: { type: "object", required: ["values", "requiresApproval"] },
      outputSchema: { type: "number" },
      requiredCapabilities: ["agent", "hooks", "approval", "dynamic_tasks"],
      dependencies: { "@earendil-works/pi-durable": "1.3.0" },
    }),
  });
  return { artifact, ...registerFixtureWorkflow(artifact, effect) };
}
