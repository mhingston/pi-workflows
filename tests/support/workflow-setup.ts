import { readFile } from "node:fs/promises";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { loadWorkflow, sha256 } from "../../src/artifact.ts";
import type { WorkflowRevision, TrustedWorkflow } from "../../src/runtime/pi-durable.ts";
import { registerExampleWorkflow, type EffectPort } from "../../fixtures/durable/workflow.ts";

export async function setupWorkflow(effects: EffectPort, override?: WorkflowRevision) {
  // This is a checked-in, installed TypeScript module: never eval downloaded source.
  const source = await readFile(new URL("../../fixtures/durable/workflow.ts", import.meta.url), "utf8");
  const revision: WorkflowRevision = {
    id: "native_example",
    version: "0.1.0",
    sourceSha256: await sha256(source),
    dependencies: { "@earendil-works/pi-durable": "1.3.0" },
  };
  const artifact = await loadWorkflow({
    source,
    manifestJson: JSON.stringify({
      schemaVersion: 1,
      ...revision,
      entrypoint: "workflow.ts",
      inputSchema: { type: "object", required: ["values"] },
      outputSchema: { type: "object" },
      requiredCapabilities: ["durable_tasks", "parallel_tasks", "conditional", "external_effect"],
    }),
  });
  const nativeRevision = override ?? revision;
  const { child, parent } = registerExampleWorkflow(effects, nativeRevision);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "pi-workflows.example", tasks: [child, parent] }));
  const registered: TrustedWorkflow<
    { values: number[] },
    { phase: "select" } | { phase: "collect"; children: import("@earendil-works/pi-durable").TaskId<number>[]; selected: number[] } | {
      phase: "effect"; selected: number[]; childResults: number[]; total: number
    },
    import("../../fixtures/durable/workflow.ts").ExampleResult
  > = {
    task: parent,
    revision: nativeRevision,
    capabilities: ["durable_tasks", "parallel_tasks", "conditional", "external_effect"],
  };
  return { revision, artifact, registered, registry };
}
