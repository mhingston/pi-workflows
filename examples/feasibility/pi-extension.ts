/**
 * Regular Pi API smoke probe (not a workflow implementation).
 *
 * npm install
 * npm run probe:pi
 * In Pi: /wf_spike hello
 * Model tool: wf_spike_echo({ text: "hello" })
 *
 * Source contract checked against @earendil-works/pi-coding-agent 1.3.0,
 * earendil-works/pi commit 482c1381a00d8d00bc81697e4a980c593db6803e.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerFeasibilityProbe(pi: ExtensionAPI): void {
  pi.registerCommand("wf_spike", {
    description: "Check command registration without invoking a model",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Pi command received: ${args || "(no input)"}`, "info");
    },
  });

  pi.registerTool({
    name: "wf_spike_echo",
    label: "Feasibility echo",
    description: "Return the supplied text unchanged; no side effects.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: params.text }],
      };
    },
  });
}
