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
  const raw = match[2]!.trim();
  // Pi supplies slash-command arguments literally; accept shell-style
  // surrounding single quotes in examples without invoking a shell parser.
  const json = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  try { input = JSON.parse(json); }
  catch { throw new WorkflowInvocationError("malformed_json", "Malformed --input-json: expected valid JSON."); }
  return { kind: "run", name: match[1]!, input };
}
