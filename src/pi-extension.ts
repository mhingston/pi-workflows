/**
 * Regular Pi entry point, NOT a runner. Native Pi Durable owns task scheduling
 * and SQLite checkpoints. Both user paths delegate to the same service.
 *
 * Load: pi --extension ./src/pi-extension.ts
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseWorkflowCommand } from "./command.ts";
import {
  createWorkflowInvocationService, type WorkflowInvocationService, type WorkflowInvocationResult,
} from "./invocation.ts";

type Context = Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "isProjectTrusted">;
export type ServiceFactory = (context: Context) => WorkflowInvocationService;

function safeResult(result: WorkflowInvocationResult): WorkflowInvocationResult {
  // These are the only result properties exposed to Pi/model consumers.
  return result;
}
export function registerWorkflowExtension(pi: ExtensionAPI, makeService: ServiceFactory = ctx =>
  createWorkflowInvocationService({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() })): void {
  const services = new Map<string, WorkflowInvocationService>();
  const getService = (ctx: Context) => {
    const key = ctx.cwd + ":" + ctx.isProjectTrusted();
    let service = services.get(key);
    if (!service) {
      service = makeService(ctx);
      services.set(key, service);
    }
    return service;
  };
  const approve = (ctx: Context) => async (name: string): Promise<boolean> => {
    // Tool invocation alone is never permission. Headless use fails closed.
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm("Approve workflow action?",
      'Permit the "' + name + '" fixture approval action? Decline to cancel.');
  };
  const commandConflict = () => pi.getCommands().filter(command => command.name === "workflow").length > 1;
  pi.on("session_start", async (_event, ctx) => {
    if (commandConflict()) {
      ctx.ui.notify('Conflicting /workflow commands detected; invocation disabled. Resolve extension collision.', "error");
    }
  });
  pi.registerCommand("workflow", {
    description: "List or run trusted Pi Durable workflows",
    handler: async (args, ctx) => {
      try {
        if (commandConflict()) {
          ctx.ui.notify("Conflicting /workflow commands; refusing to invoke.", "error");
          return;
        }
        const cmd = parseWorkflowCommand(args);
        const service = getService(ctx);
        const result = cmd.kind === "list"
          ? await service.list()
          : safeResult(await service.run(cmd.name, cmd.input, { authorize: approve(ctx) }));
        ctx.ui.notify(JSON.stringify(result), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Workflow invocation failed.", "error");
      }
    },
  });
  pi.registerTool({
    name: "run_workflow",
    label: "Run trusted workflow",
    description: "Execute an exact named, trusted workflow via native Pi Durable. Available workflow: dynamic_agents. Use input with numeric values and requiresApproval boolean. Approval may require interactive confirmation.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact workflow ID (e.g. dynamic_agents)" }),
      input: Type.Object({
        values: Type.Array(Type.Number()),
        requiresApproval: Type.Boolean(),
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = safeResult(await getService(ctx).run(params.name, params.input,
          { authorize: approve(ctx) }));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workflow invocation failed.";
        return { content: [{ type: "text" as const, text: message }],
          details: { status: "error", message } };
      }
    },
  });
}
export default registerWorkflowExtension;
