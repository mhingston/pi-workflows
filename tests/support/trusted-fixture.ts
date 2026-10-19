/** Trusted fixture only. The checked-in manifest is the single source of metadata. */
import { readFile } from "node:fs/promises";
import { loadWorkflow } from "../../src/artifact.ts";
import { registerFixtureWorkflow, type ApprovalEffect, type FixtureProbe } from "../../src/durable/fixture-runtime.ts";

export async function trustedFixture(effect: ApprovalEffect, probe?: FixtureProbe) {
  const source = await readFile(new URL("../../fixtures/complex/workflow.ts", import.meta.url), "utf8");
  const manifestJson = await readFile(new URL("../../fixtures/complex/workflow.json", import.meta.url), "utf8");
  const artifact = await loadWorkflow({ source, manifestJson });
  return { artifact, ...registerFixtureWorkflow(artifact, effect, undefined, probe) };
}
