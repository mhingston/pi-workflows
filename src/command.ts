/** Strict parsing of explicit commands; never natural-language matching. */
import { WorkflowInvocationError } from "./invocation.ts";

export type WorkflowCommand =
  | { kind: "list" }
  | { kind: "run"; name: string; input: unknown };

export function parseWorkflowCommand(args: string): WorkflowCommand {
  const trimmed = args.trim();
  if (trimmed === "list") return { kind: "list" };
  const match = /^run\s+([a-z][a-z0-9_-]*)\s+--input-json\s+([\s\S]+)$/.exec(trimmed);
  if (!match) {
    throw new WorkflowInvocationError("usage",
      'Usage: /workflow list OR /workflow run <name> --input-json \'{"values":[1],"requiresApproval":false}\'');
  }
  let input: unknown;
  try { input = JSON.parse(match[2]!); }
  catch { throw new WorkflowInvocationError("malformed_json", "Malformed --input-json: expected valid JSON."); }
  return { kind: "run", name: match[1]!, input };
}
