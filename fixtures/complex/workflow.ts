/**
 * Deliberately dynamic, trusted workflow example. This is not a new
 * workflow DSL: a runtime adapter decides how to implement these ports.
 */
export interface WorkflowPorts {
  agent(name: string, value: number): Promise<number>;
  hook(name: string, value: unknown): Promise<void>;
  approve(reason: string): Promise<boolean>;
}

export interface WorkflowInput {
  values: number[];
  requiresApproval: boolean;
}

export async function runWorkflow(input: WorkflowInput, ports: WorkflowPorts): Promise<number> {
  await ports.hook("before", input);

  // Conditional branch + dynamic fan-out: neither the node count nor its
  // dependency graph is determined when the workflow is authored.
  const candidates = input.values.filter(value => value > 0);
  let total = 0;
  for (let offset = 0; offset < candidates.length; offset += 2) {
    const batch = candidates.slice(offset, offset + 2);
    const results = await Promise.all(batch.map(value => ports.agent("worker", value)));
    total += results.reduce((sum, item) => sum + item, 0);
  }

  if (input.requiresApproval && total > 3) {
    if (!await ports.approve("Large result requires approval")) {
      throw new Error("approval denied");
    }
  }

  // Opaque callback logic is preserved, never translated into graph edges.
  const mapped = (n: number) => n * 2;
  const output = mapped(total);
  await ports.hook("after", output);
  return output;
}
