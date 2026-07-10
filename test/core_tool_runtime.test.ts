import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getJob,
  listJobCheckpoints,
  listJobSteps,
  resumeToolRequest,
  runToolRequest,
} from "../src/core/index.js";
import { DEFAULT_METADATA_TIMEOUT_MS, parseMetadataTimeoutMs } from "../src/workflows/file.js";
import { invokeLlmText } from "../src/commands/stdlib/llm_client.js";

function createDirectAdapter(resultText: string) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    adapter: {
      source: "test",
      async invoke({ payload }: { payload: Record<string, unknown> }) {
        calls.push(payload);
        return {
          ok: true,
          result: {
            runId: "adapter_1",
            model: "test/model",
            prompt: payload.prompt,
            status: "completed",
            output: {
              format: "json",
              text: resultText,
              data: JSON.parse(resultText),
            },
          },
        };
      },
    },
  };
}

test("runToolRequest executes pipeline with injected llm adapter", async () => {
  const { adapter, calls } = createDirectAdapter('{"recommendation":"no jacket"}');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-tool-runtime-run-"));
  const envelope = await runToolRequest({
    pipeline:
      'exec --json=true node -e "process.stdout.write(JSON.stringify({location:\'Phoenix\',temp_f:73.8}))" | llm.invoke --provider pi --prompt "Should I wear a jacket?" --disable-cache',
    ctx: {
      env: {
        ...process.env,
        LOBSTER_DIR: tmpDir,
        LOBSTER_LLM_PROVIDER: "pi",
        LOBSTER_LLM_MODEL: "test/model",
      },
      llmAdapters: {
        pi: adapter,
      },
    },
  });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.output?.length, 1);
  assert.equal((envelope.output![0] as any).output.data.recommendation, "no jacket");
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).model, "test/model");
});

test("resumeToolRequest completes approval-gated workflow with injected llm adapter", async () => {
  const { adapter, calls } = createDirectAdapter('{"recommendation":"no","reason":"warm"}');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-tool-runtime-"));
  const filePath = path.join(tmpDir, "workflow.lobster");

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "fetch",
            run: "node -e \"process.stdout.write(JSON.stringify({location:'Phoenix',temp_f:73.8}))\"",
          },
          {
            id: "confirm",
            approval: "Want jacket advice?",
            stdin: "$fetch.json",
          },
          {
            id: "advice",
            pipeline: 'llm.invoke --provider pi --prompt "Return JSON." --disable-cache',
            stdin: "$fetch.json",
            when: "$confirm.approved",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
    LOBSTER_LLM_PROVIDER: "pi",
    LOBSTER_LLM_MODEL: "test/model",
  };

  const first = await runToolRequest({
    filePath,
    ctx: {
      cwd: tmpDir,
      env,
      llmAdapters: { pi: adapter },
    },
  });

  assert.equal(first.ok, true);
  assert.equal(first.status, "needs_approval");
  assert.ok(first.requiresApproval?.resumeToken);

  const resumed = await resumeToolRequest({
    token: first.requiresApproval?.resumeToken ?? "",
    approved: true,
    ctx: {
      cwd: tmpDir,
      env,
      llmAdapters: { pi: adapter },
    },
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "ok");
  assert.equal((resumed.output![0] as any).output.data.reason, "warm");
  assert.equal(calls.length, 1);
});

test("runToolRequest/resumeToolRequest handles needs_input workflow pauses", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-tool-input-"));
  const filePath = path.join(tmpDir, "workflow.lobster");

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "draft",
            run: "node -e \"process.stdout.write(JSON.stringify({text:'hello'}))\"",
          },
          {
            id: "review",
            input: {
              prompt: "Review draft?",
              responseSchema: {
                type: "object",
                properties: { decision: { type: "string" } },
                required: ["decision"],
              },
            },
          },
          {
            id: "finish",
            run: 'node -e "process.stdout.write(JSON.stringify({decision:process.env.DECISION,subject:process.env.SUBJECT}))"',
            env: {
              DECISION: "$review.response.decision",
              SUBJECT: "$review.subject.text",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({
    filePath,
    ctx: { cwd: tmpDir, env },
  });

  assert.equal(first.ok, true);
  assert.equal(first.status, "needs_input");
  assert.deepEqual(first.requiresInput?.subject, { text: "hello" });
  assert.ok(first.requiresInput?.resumeToken);

  const resumed = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? "",
    response: { decision: "approve" },
    ctx: { cwd: tmpDir, env },
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ decision: "approve", subject: "hello" }]);
});

test("workflow step failure with default on_error records a failed step boundary", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-step-fail-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "fail", run: "node -e \"process.stderr.write('boom');process.exit(1)\"" },
          { id: "after", run: "echo should-not-run" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  let jobId: string | undefined;
  const ctx = { cwd: tmpDir, env };

  const result = await runToolRequest({
    filePath,
    ctx: { ...ctx, observer: { onJobCreated: (job) => void (jobId = job.jobId) } },
  });
  assert.equal(result.ok, false);
  assert.ok(jobId);
  assert.match(result.error?.message ?? "", /workflow command failed/);

  const checkpoints = await listJobCheckpoints({ jobId: jobId!, ctx });
  const failedBoundary = checkpoints.find(
    (cp) => cp.stepId === "fail" && cp.kind === "step" && cp.status === "failed",
  );
  assert.ok(failedBoundary, "expected a failed step checkpoint before the run failed");
  assert.equal(failedBoundary?.stepPath, "root.fail");
  assert.equal(failedBoundary?.name, "shell");

  const steps = await listJobSteps({ jobId: jobId!, ctx });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].stepId, "fail");
  assert.equal(steps[0].status, "failed");
  assert.equal(steps[0].boundaryCheckpointId, failedBoundary?.checkpointId);
});

function createMetadataTextHook() {
  const calls: Array<{ prompt: string; model?: string | null }> = [];
  return {
    calls,
    llmText: async ({
      prompt,
      model,
    }: {
      prompt: string;
      model?: string | null;
      signal?: AbortSignal;
    }) => {
      calls.push({ prompt, model: model ?? null });
      const text = /concise title/.test(prompt)
        ? "Weather Summary"
        : "The step summarized the current weather reading.";
      return { text };
    },
  };
}

async function writeAutoMetadataWorkflow(
  tmpDir: string,
  options?: { onError?: "stop" | "continue" | "skip_rest" },
) {
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "summarize",
            run: 'node -e "process.stdout.write(JSON.stringify({temp_f:73}))"',
            metadata: "auto",
            ...(options?.onError ? { on_error: options.onError } : {}),
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

test("metadata:auto resolves in-process via ctx.llmText, writes job title/description, and emits a succeeded metadata checkpoint", async () => {
  const { llmText, calls } = createMetadataTextHook();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir);
  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };
  const ctx = { cwd: tmpDir, env, llmText };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(result.jobId);

  // Resolution used the injected in-process text hook (one call per auto field), no adapter/HTTP.
  assert.equal(calls.length, 2);

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title, "Weather Summary");
  assert.equal(job?.description, "The step summarized the current weather reading.");

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const metadataCheckpoint = checkpoints.find(
    (cp) => cp.name === "metadata" && cp.kind === "detail" && cp.status === "succeeded",
  );
  assert.ok(metadataCheckpoint, "expected a succeeded metadata checkpoint");
  assert.equal(metadataCheckpoint?.stepId, "summarize");
  assert.equal(metadataCheckpoint?.stepPath, "root.summarize");
});

test("metadata:auto failure follows the step's default on_error (stop) and errors the run", async () => {
  const calls: string[] = [];
  const failingText = async ({ prompt }: { prompt: string }) => {
    calls.push(prompt);
    throw new Error("llm exploded");
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-fail-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir);
  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };
  let jobId: string | undefined;
  const ctx = {
    cwd: tmpDir,
    env,
    llmText: failingText,
    observer: { onJobCreated: (job: { jobId: string }) => void (jobId = job.jobId) },
  };

  const result = await runToolRequest({ filePath, ctx });
  // Default on_error is "stop": the metadata failure halts the run like any step failure.
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /llm exploded/);
  assert.ok(jobId);
  assert.ok(calls.length >= 1);

  const checkpoints = await listJobCheckpoints({ jobId: jobId!, ctx });
  const failedMetadata = checkpoints.find(
    (cp) => cp.name === "metadata" && cp.kind === "detail" && cp.status === "failed",
  );
  assert.ok(failedMetadata, "expected a failed metadata detail checkpoint");
  const failedBoundary = checkpoints.find(
    (cp) => cp.name === "shell" && cp.kind === "step" && cp.status === "failed",
  );
  assert.ok(failedBoundary, "metadata stop failure must flip the owning step boundary to failed");
  assert.equal(failedBoundary?.stepId, "summarize");
  assert.equal(failedBoundary?.stepPath, "root.summarize");

  const steps = await listJobSteps({ jobId: jobId!, ctx });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].stepId, "summarize");
  assert.equal(steps[0].status, "failed");
  assert.equal(steps[0].boundaryCheckpointId, failedBoundary?.checkpointId);
});

test("metadata:auto failure with on_error continue records a scoped failed checkpoint and finishes the run", async () => {
  const calls: string[] = [];
  const failingText = async ({ prompt }: { prompt: string }) => {
    calls.push(prompt);
    throw new Error("llm exploded");
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-cont-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir, { onError: "continue" });
  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };
  const ctx = { cwd: tmpDir, env, llmText: failingText };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(calls.length >= 1);

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title ?? null, null);
  assert.equal(job?.description ?? null, null);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const failed = checkpoints.find(
    (cp) => cp.name === "metadata" && cp.kind === "detail" && cp.status === "failed",
  );
  assert.ok(failed, "expected a failed metadata checkpoint");
  assert.equal(failed?.stepId, "summarize");
  assert.equal(failed?.stepPath, "root.summarize");
  const failedBoundary = checkpoints.find(
    (cp) => cp.name === "shell" && cp.kind === "step" && cp.status === "failed",
  );
  assert.ok(
    failedBoundary,
    "metadata continue failure must flip the owning step boundary to failed",
  );
  const steps = await listJobSteps({ jobId: result.jobId!, ctx });
  assert.equal(steps[0].status, "failed");
  assert.ok(
    !checkpoints.some(
      (cp) => cp.name === "metadata" && cp.kind === "detail" && cp.status === "succeeded",
    ),
    "no succeeded metadata checkpoint should be recorded on failure",
  );
});

test("metadata:auto empty output is a failure (metadata_generation_empty), not a silent no-op", async () => {
  const calls: string[] = [];
  const emptyText = async ({ prompt }: { prompt: string }) => {
    calls.push(prompt);
    return { text: "" };
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-empty-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir, { onError: "continue" });
  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };
  const ctx = { cwd: tmpDir, env, llmText: emptyText };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(calls.length >= 1);

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title ?? null, null);
  assert.equal(job?.description ?? null, null);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const failed = checkpoints.find(
    (cp) => cp.name === "metadata" && cp.kind === "detail" && cp.status === "failed",
  );
  assert.ok(failed, "expected a failed metadata checkpoint");
  assert.equal(failed?.stepId, "summarize");
  assert.equal(failed?.stepPath, "root.summarize");
  const failedBoundary = checkpoints.find(
    (cp) => cp.name === "shell" && cp.kind === "step" && cp.status === "failed",
  );
  assert.ok(
    failedBoundary,
    "metadata empty-output failure must flip the owning step boundary to failed",
  );
  const steps = await listJobSteps({ jobId: result.jobId!, ctx });
  assert.equal(steps[0].status, "failed");
  assert.equal(
    (failed?.metadata as { reason?: string } | undefined)?.reason,
    "metadata_generation_empty",
  );
});

// --- Metadata auto timeout tests ---

test("parseMetadataTimeoutMs falls back to the 60s default for missing/invalid/non-positive values", () => {
  assert.equal(DEFAULT_METADATA_TIMEOUT_MS, 60_000);
  assert.equal(parseMetadataTimeoutMs({}), 60_000);
  assert.equal(parseMetadataTimeoutMs({ LOBSTER_METADATA_TIMEOUT_MS: "abc" }), 60_000);
  assert.equal(parseMetadataTimeoutMs({ LOBSTER_METADATA_TIMEOUT_MS: "0" }), 60_000);
  assert.equal(parseMetadataTimeoutMs({ LOBSTER_METADATA_TIMEOUT_MS: "-10" }), 60_000);
  assert.equal(parseMetadataTimeoutMs({ LOBSTER_METADATA_TIMEOUT_MS: "1500" }), 1500);
});

test("invokeLlmText rejects with a timeout error when the adapter never resolves", async () => {
  const hangingAdapter = {
    source: "test-hang",
    invoke: () => new Promise<never>(() => {}),
  };
  const ctx = { llmAdapters: { pi: hangingAdapter } };
  const env = { LOBSTER_LLM_PROVIDER: "pi" };
  await assert.rejects(
    invokeLlmText({ ctx, env, prompt: "summarize", timeoutMs: 200 }),
    /metadata auto-generation timed out after 200ms/,
  );
});

test("invokeLlmText propagates an external abort signal immediately", async () => {
  const hangingAdapter = {
    source: "test-hang",
    invoke: () => new Promise<never>(() => {}),
  };
  const ctx = { llmAdapters: { pi: hangingAdapter } };
  const env = { LOBSTER_LLM_PROVIDER: "pi" };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    invokeLlmText({ ctx, env, prompt: "summarize", signal: controller.signal, timeoutMs: 60_000 }),
    (err: any) => err?.name === "AbortError" || /abort/i.test(String(err?.message ?? err)),
  );
});

test("metadata:auto timeout follows on_error continue and records a failed checkpoint", async () => {
  const hangingText = () => new Promise<never>(() => {});
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-timeout-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir, { onError: "continue" });
  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
    LOBSTER_METADATA_TIMEOUT_MS: "300",
  };
  const ctx = { cwd: tmpDir, env, llmText: hangingText };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title ?? null, null);
  assert.equal(job?.description ?? null, null);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const failed = checkpoints.find(
    (cp) => cp.name === "metadata" && cp.kind === "detail" && cp.status === "failed",
  );
  assert.ok(failed, "expected a failed metadata checkpoint");
  assert.equal(failed?.stepId, "summarize");
  assert.equal(failed?.stepPath, "root.summarize");
  assert.equal(
    (failed?.metadata as { reason?: string } | undefined)?.reason,
    "metadata_generation_failed",
  );
});

test("invokeLlmText prefers ctx.llmText and never touches llmAdapters", async () => {
  const hookCalls: Array<{ prompt: string; model?: string | null }> = [];
  const adapterCalls: unknown[] = [];
  const ctx = {
    llmText: async ({ prompt, model }: { prompt: string; model?: string | null }) => {
      hookCalls.push({ prompt, model: model ?? null });
      return { text: "hook result" };
    },
    // Present but must be ignored by the internal text path.
    llmAdapters: {
      openclaw: {
        source: "should-not-run",
        async invoke() {
          adapterCalls.push(true);
          return { ok: true, result: { output: { text: "adapter result", data: null } } };
        },
      },
    },
  };
  const env = {};
  const result = await invokeLlmText({
    ctx,
    env,
    prompt: "summarize",
    model: "m/x",
    timeoutMs: 5_000,
  });
  assert.equal(result.text, "hook result");
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0]!.model, "m/x");
  assert.equal(adapterCalls.length, 0);
});

test("invokeLlmText surfaces host usage from ctx.llmText", async () => {
  const ctx = {
    llmText: async () => ({
      text: "hook result",
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }),
  };
  const result = await invokeLlmText({
    ctx,
    env: {},
    prompt: "summarize",
    model: "m/x",
    timeoutMs: 5_000,
  });
  assert.equal(result.text, "hook result");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  assert.equal(result.model, "m/x");
});

async function writeTwoStepWorkflow(tmpDir: string): Promise<string> {
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "first", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          { id: "second", run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"' },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

test("run observer fires onJobCreated before any checkpoint and onCheckpoint per durable checkpoint", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-observer-"));
  const filePath = await writeTwoStepWorkflow(tmpDir);
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  const events: string[] = [];
  let createdInfo: any;
  const checkpointJobIds: string[] = [];
  const observer = {
    onJobCreated: (info: any) => {
      createdInfo = info;
      events.push("job");
    },
    onCheckpoint: (cp: any) => {
      checkpointJobIds.push(cp.jobId);
      events.push("cp");
    },
  };

  const result = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env, observer } });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(result.jobId);

  // The job is announced exactly once, before any checkpoint streams.
  assert.equal(events[0], "job");
  assert.equal(events.filter((e) => e === "job").length, 1);
  assert.equal(createdInfo.jobId, result.jobId);
  assert.equal(createdInfo.sourceType, "workflow_file");

  // Every step checkpoint is streamed live and carries the run's jobId.
  assert.ok(events.filter((e) => e === "cp").length >= 2);
  assert.ok(checkpointJobIds.every((id) => id === result.jobId));
});

test("run observer onJobCreated throwing aborts the run before any step executes", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-observer-abort-"));
  const filePath = await writeTwoStepWorkflow(tmpDir);
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  let checkpointCount = 0;
  let createdJobId: string | undefined;
  const observer = {
    onJobCreated: (info: any) => {
      createdJobId = info.jobId;
      throw new Error("bind boom");
    },
    onCheckpoint: () => {
      checkpointCount += 1;
    },
  };

  const result = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env, observer } });
  // The run is aborted before any step runs; no checkpoints stream.
  assert.equal(result.ok, false);
  assert.equal(checkpointCount, 0);

  // The job row exists (announced) but no step checkpoints were recorded.
  assert.ok(createdJobId);
  const checkpoints = await listJobCheckpoints({ jobId: createdJobId!, ctx: { cwd: tmpDir, env } });
  assert.ok(!checkpoints.some((cp) => cp.stepId === "first" || cp.stepId === "second"));
});

test("nested-workflow condition passes when structured llm.invoke returns output.data (regression)", async () => {
  // A structured provider-keyed transport override (like the gateway) returns
  // output.data; the child workflow gets its args and its condition passes. This
  // guards the regression where a text-only adapter nulled output.data and made
  // every conditional nested workflow skip.
  const structuredAdapter = {
    source: "test-structured",
    async invoke({ payload }: { payload: Record<string, unknown> }) {
      return {
        ok: true,
        result: {
          runId: "route_1",
          prompt: payload.prompt,
          status: "completed",
          output: {
            format: "json",
            text: '{"run_child":true,"ticket_id":"T-202"}',
            data: { run_child: true, ticket_id: "T-202" },
          },
        },
      };
    },
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-nested-route-"));
  const childPath = path.join(tmpDir, "child.lobster");
  await fsp.writeFile(
    childPath,
    JSON.stringify(
      {
        args: { ticket_id: { default: "" } },
        steps: [
          {
            id: "handle",
            command:
              'node -e "process.stdout.write(JSON.stringify({handled: process.env.LOBSTER_ARG_TICKET_ID}))"',
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const parentPath = path.join(tmpDir, "parent.lobster");
  await fsp.writeFile(
    parentPath,
    JSON.stringify(
      {
        steps: [
          {
            id: "route",
            pipeline: 'llm.invoke --provider pi --prompt "route" --disable-cache',
          },
          {
            id: "run-child",
            workflow: "child.lobster",
            workflow_args: { ticket_id: "$route.json.output.data.ticket_id" },
            condition: "$route.json.output.data.run_child",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
    LOBSTER_LLM_PROVIDER: "pi",
    LOBSTER_LLM_MODEL: "test/model",
  };
  const ctx = { cwd: tmpDir, env, llmAdapters: { pi: structuredAdapter } };

  const result = await runToolRequest({ filePath: parentPath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  // The nested workflow ran (condition true) and received ticket_id from output.data.
  assert.deepEqual(result.output, [{ handled: "T-202" }]);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const childStep = checkpoints.find((cp) => cp.stepId === "run-child");
  assert.ok(childStep, "expected a checkpoint for the nested workflow step");
  assert.notEqual(childStep?.status, "skipped");
});
