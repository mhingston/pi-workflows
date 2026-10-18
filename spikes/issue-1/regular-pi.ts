/**
 * Issue #1: verify the *regular Pi coding-agent* extension registration surface.
 *
 * Usage:
 *   pi --extension ./spikes/issue-1/regular-pi.ts
 *   /spike-workflow hello
 *
 * The model can also call spike_workflow with {"name":"hello"}.
 * This is intentionally only a deterministic adapter wiring probe, NOT a
 * working workflow runtime or an implicit prompt matcher.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const response = (name: string) => `workflow probe: ${name || "default"}`;

export default function registerProbe(pi: ExtensionAPI): void {
  pi.registerCommand("spike-workflow", {
    description: "Probe explicit workflow command registration",
    handler: async (args, ctx) => {
      ctx.ui.notify(response(args.trim()), "info");
    },
  });

  pi.registerTool({
    name: "spike_workflow",
    label: "Workflow registration probe",
    description: "Echo a workflow probe name (no side effects).",
    parameters: Type.Object({
      name: Type.String({ description: "Probe name" }),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: response(params.name) }], details: { name: params.name } };
    },
  });
}
