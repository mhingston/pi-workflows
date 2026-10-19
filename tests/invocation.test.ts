import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowInvocationService } from "../src/invocation.ts";
import { parseWorkflowCommand } from "../src/command.ts";
import { registerWorkflowExtension } from "../src/pi-extension.ts";
import { sha256 } from "../src/artifact.ts";

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflows-invocation-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function piAdapter(service: ReturnType<typeof createWorkflowInvocationService>, cwd: string) {
  const messages: Array<{ message: string; level: string }> = [];
  let commands: Array<{ name: string }> = [{ name: "workflow" }];
  const registered = { command: undefined as undefined | ((args: string, ctx: ExtensionContext) => Promise<void>),
    tool: undefined as undefined | ((id: string, p: { name: string; input: { values: number[]; requiresApproval: boolean } },
      signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<{
        content: Array<{ type: "text"; text: string }>; details: unknown
      }>) };
  const fakePi = {
    registerCommand: (_name: string, options: { handler: typeof registered.command }) => {
      registered.command = options.handler;
    },
    registerTool: (tool: { execute: typeof registered.tool }) => { registered.tool = tool.execute; },
    getCommands: () => commands,
    on: () => () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, hasUI: true, isProjectTrusted: () => true,
    ui: {
      notify: (message: string, level: string) => messages.push({ message, level }),
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;
  registerWorkflowExtension(fakePi, () => service);
  assert.ok(registered.command);
  assert.ok(registered.tool);
  return { command: registered.command!, tool: registered.tool!, ctx, messages,
    setCommands(value: Array<{ name: string }>) { commands = value; } };
}

test("strict command parser rejects malformed JSON and implicit/natural-language invocation", () => {
  assert.deepEqual(parseWorkflowCommand("list"), { kind: "list" });
  assert.deepEqual(parseWorkflowCommand('run dynamic_agents --input-json {"values":[1,2,3],"requiresApproval":false}'),
    { kind: "run", name: "dynamic_agents", input: { values: [1, 2, 3], requiresApproval: false } });
  assert.throws(() => parseWorkflowCommand("run dynamic_agents --input-json {no"), /Malformed/);
  assert.throws(() => parseWorkflowCommand("please run dynamic_agents"), /Usage/);
  assert.throws(() => parseWorkflowCommand("run dynamic_agents"), /Usage/);
});

test("command and model tool delegate to the same service and persist real native Pi Durable IDs", async () =>
  inTemp(async dir => {
    const service = createWorkflowInvocationService({ cwd: dir, home: dir });
    const pi = piAdapter(service, dir);
    await pi.command("list", pi.ctx);
    assert.deepEqual(JSON.parse(pi.messages.at(-1)!.message).map((x: { name: string }) => x.name), ["dynamic_agents"]);

    await pi.command('run dynamic_agents --input-json {"values":[1,2,3],"requiresApproval":false}', pi.ctx);
    const fromCommand = JSON.parse(pi.messages.at(-1)!.message) as { status: string; output: number; runId: number };
    const fromTool = await pi.tool("call", { name: "dynamic_agents",
      input: { values: [1, 2, 3], requiresApproval: false } }, undefined, undefined, pi.ctx);
    const fromModel = JSON.parse(fromTool.content[0]!.text) as typeof fromCommand;
    assert.deepEqual([fromCommand.status, fromCommand.output], ["completed", 12]);
    assert.deepEqual([fromModel.status, fromModel.output], ["completed", 12]);
    assert.ok(Number.isSafeInteger(fromCommand.runId));
    assert.ok(Number.isSafeInteger(fromModel.runId));
    assert.notEqual(fromCommand.runId, fromModel.runId);
    assert.equal((fromTool.details as { runId: number }).runId, fromModel.runId);

    const { trustedFixture } = await import("./support/trusted-fixture.ts");
    const { registry } = await trustedFixture({ approve: async () => true });
    const { Harness } = await import("@earendil-works/pi-durable");
    const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
    const { createModels } = await import("@earendil-works/pi-ai/models");
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, ".pi", "workflow-runs.sqlite")),
      { models: createModels(), registry }, BACKGROUND_CONTEXT);
    try {
      for (const id of [fromCommand.runId, fromModel.runId]) {
        const record = await harness.getTask(id, BACKGROUND_CONTEXT);
        assert.equal(record?.state.status, "terminal");
      }
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  }));

test("input and permission failures occur before any durable task is created", async () => inTemp(async dir => {
  const svc = createWorkflowInvocationService({ cwd: dir, home: dir });
  await assert.rejects(svc.run("unknown", {}), /Unknown workflow/);
  await assert.rejects(svc.run("dynamic_agents", { values: "abc", requiresApproval: false }), /Invalid workflow input/);
  await assert.rejects(svc.run("dynamic_agents", { values: [1, 2] }), /Invalid workflow input/);
  await assert.rejects(svc.run("dynamic_agents", { values: [2, 3], requiresApproval: true }), /not explicitly approved/);
  const pi = piAdapter(svc, dir);
  pi.ctx.ui.confirm = async () => false;
  await pi.command('run dynamic_agents --input-json {"values":[2,3],"requiresApproval":true}', pi.ctx);
  assert.equal(pi.messages.at(-1)!.level, "error");
  const fromTool = await pi.tool("call", { name: "dynamic_agents", input: {
    values: [2, 3], requiresApproval: true,
  } }, undefined, undefined, pi.ctx);
  assert.match(fromTool.content[0]!.text, /not explicitly approved/);
  await assert.rejects(access(join(dir, ".pi", "workflow-runs.sqlite")));
}));

test("unsupported capabilities fail closed; ambiguous effects stay needs_reconciliation", async () => inTemp(async dir => {
  const unsupported = createWorkflowInvocationService({ cwd: dir, home: dir, capabilities: ["agent"] });
  await assert.rejects(unsupported.run("dynamic_agents", { values: [1], requiresApproval: false }),
    /Unsupported runtime capabilities/);
  const svc = createWorkflowInvocationService({
    cwd: dir, home: dir,
    fixtureEffect: { approve: async () => { throw new Error("uncertain remote effect"); } },
  });
  const input = { values: [2, 3], requiresApproval: true };
  const result = await svc.run("dynamic_agents", input, { authorize: async () => true });
  assert.equal(result.status, "needs_reconciliation");
  if (result.status === "needs_reconciliation") {
    assert.ok(result.effectKey.includes("approval"));
    assert.ok(Number.isSafeInteger(result.runId));
  }
}));

test("untrusted code is never imported; duplicates are rejected deterministically", async () => inTemp(async dir => {
  const evilDir = join(dir, ".pi", "workflows", "evil");
  await mkdir(evilDir, { recursive: true });
  const marker = join(dir, "executed");
  const source = 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "bad");\n';
  const trustedJson = JSON.parse(await readFile(new URL("../fixtures/complex/workflow.json", import.meta.url), "utf8"));
  const evilJson = { ...trustedJson, id: "evil", sourceSha256: await sha256(source) };
  await writeFile(join(evilDir, "workflow.ts"), source);
  await writeFile(join(evilDir, "workflow.json"), JSON.stringify(evilJson));
  const svc = createWorkflowInvocationService({ cwd: dir, home: dir });
  assert.deepEqual((await svc.list()).map(w => w.name), ["dynamic_agents"]);
  await assert.rejects(svc.run("evil", { values: [], requiresApproval: false }), /untrusted/);
  await assert.rejects(access(marker), "untrusted TypeScript must not execute");

  const same = join(dir, ".pi", "workflows", "dynamic_agents");
  await mkdir(same, { recursive: true });
  await copyFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), join(same, "workflow.ts"));
  await copyFile(new URL("../fixtures/complex/workflow.json", import.meta.url), join(same, "workflow.json"));
  const userSame = join(dir, ".pi", "workflows", "again");
  // This duplicate has the same manifest ID, not the directory name.
  await mkdir(userSame, { recursive: true });
  await copyFile(new URL("../fixtures/complex/workflow.ts", import.meta.url), join(userSame, "workflow.ts"));
  await copyFile(new URL("../fixtures/complex/workflow.json", import.meta.url), join(userSame, "workflow.json"));
  await assert.rejects(svc.list(), /Duplicate workflow name/);
}));

test("conflicting Pi /workflow commands are refused (not overwritten)", async () => inTemp(async dir => {
  const svc = createWorkflowInvocationService({ cwd: dir, home: dir });
  const pi = piAdapter(svc, dir);
  pi.setCommands([{ name: "workflow" }, { name: "workflow" }]);
  await pi.command('run dynamic_agents --input-json {"values":[1],"requiresApproval":false}', pi.ctx);
  assert.match(pi.messages.at(-1)!.message, /Conflicting/);
  await assert.rejects(access(join(dir, ".pi", "workflow-runs.sqlite")));
}));
