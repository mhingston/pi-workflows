import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTrustedWorkflow } from "../src/runtime/pi-durable.ts";
import { FileEffectPort } from "./support/external-effect.ts";
import { setupWorkflow } from "./support/workflow-setup.ts";

const worker = fileURLToPath(new URL("./support/durable-worker.ts", import.meta.url));
type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/** Separate processes force realistic SQLite reopen rather than in-memory harness recovery. */
function runWorker(mode: string, directory: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", worker, mode, directory], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("durable-worker timed out: " + mode + "\n" + stdout + "\n" + stderr));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (mode === "crash" && !killed && stdout.includes("EFFECT_APPLIED")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", err => { clearTimeout(timeout); reject(err); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function withDirectory(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflows-durable-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function output(dir: string) {
  return JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as {
    taskId: number;
    state: string;
    recordedInput: {
      runId: string;
      revision: { id: string; version: string; sourceSha256: string };
      input: { values: number[] };
    };
    outcome: {
      status: string;
      result?: {
        runId: string; branch: string; childResults: number[]; total: number;
        effect: { idempotencyKey: string; disposition: string } | null;
      };
      error?: { message: string };
    };
  };
}

async function effectReceipts(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => name.startsWith("effect-") && name.endsWith(".json"));
}

test("native Pi Durable workflow branches, fans out children and persists terminal receipt", {
  timeout: 30_000,
}, async () => withDirectory(async dir => {
  const execution = await runWorker("normal", dir);
  assert.equal(execution.code, 0, execution.stderr);
  const result = await output(dir);
  assert.equal(result.state, "terminal");
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.result?.branch, "processed");
  assert.deepEqual(result.outcome.result?.childResults, [4, 6]);
  assert.equal(result.outcome.result?.total, 10);
  assert.equal(result.recordedInput.runId, "test-run");
  assert.equal(result.recordedInput.revision.version, "0.1.0");
  assert.match(result.recordedInput.revision.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.recordedInput.input.values, [2, -3, 3]);
  assert.equal((await effectReceipts(dir)).length, 1);
}));

test("conditional skipped branch creates no external effect", {
  timeout: 30_000,
}, async () => withDirectory(async dir => {
  const execution = await runWorker("skip", dir);
  assert.equal(execution.code, 0, execution.stderr);
  const result = await output(dir);
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.result?.branch, "skipped");
  assert.equal(result.outcome.result?.total, 0);
  assert.deepEqual(result.outcome.result?.childResults, []);
  assert.equal(result.outcome.result?.effect, null);
  assert.equal((await effectReceipts(dir)).length, 0);
}));

test("SIGKILL after external effect before Pi commit replays phase without duplicate side effect", {
  timeout: 40_000,
}, async () => withDirectory(async dir => {
  const crashed = await runWorker("crash", dir);
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.match(crashed.stdout, /EFFECT_APPLIED/);
  assert.equal((await effectReceipts(dir)).length, 1);

  const resumed = await runWorker("resume", dir);
  assert.equal(resumed.code, 0, resumed.stderr);
  const result = await output(dir);
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.result?.total, 10);
  assert.deepEqual(result.outcome.result?.childResults, [4, 6]);
  assert.equal(result.outcome.result?.effect?.disposition, "already_applied");
  assert.equal((await effectReceipts(dir)).length, 1);

  const attempts = (await readFile(join(dir, "attempts.txt"), "utf8")).trim().split("\n");
  assert.equal(attempts.length, 2, "effect phase should attempt twice across crash");
  assert.equal(attempts[0], attempts[1], "the replay must reuse its idempotency key");
}));

test("conflicting external receipt fails closed for manual reconciliation", {
  timeout: 30_000,
}, async () => withDirectory(async dir => {
  const run = await runWorker("uncertain", dir);
  assert.equal(run.code, 0, run.stderr);
  const result = await output(dir);
  assert.equal(result.outcome.status, "failed");
  assert.match(result.outcome.error?.message ?? "", /manual reconciliation required/);
  assert.equal((await effectReceipts(dir)).length, 1);
}));

test("reject unsupported or mismatched trusted workflow bindings before creating tasks", {
  timeout: 30_000,
}, async () => withDirectory(async dir => {
  const context = BACKGROUND_CONTEXT;
  const { artifact, registered, registry } = await setupWorkflow(new FileEffectPort(dir));
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "session.sqlite")),
    { models: createModels(), registry },
    context,
  );
  try {
    await assert.rejects(
      startTrustedWorkflow(harness, artifact, {
        ...registered, revision: { ...registered.revision, version: "0.1.1" },
      }, { values: [2] }, context),
      /does not match the trusted installed revision/,
    );
    await assert.rejects(
      startTrustedWorkflow(harness, artifact, {
        ...registered, capabilities: [],
      }, { values: [2] }, context),
      /unsupported workflow capabilities/,
    );
    const graph = await harness.taskGraph(context);
    try {
      assert.equal(Object.keys(graph.value.tasks).length, 0);
    } finally {
      graph.dispose();
    }
  } finally {
    await harness.close(context);
  }
}));
