import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import { getJob, listJobCheckpoints, resumeToolRequest, runToolRequest } from "../src/core/index.js";
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
  const envelope = await runToolRequest({
    pipeline:
      'exec --json=true node -e "process.stdout.write(JSON.stringify({location:\'Phoenix\',temp_f:73.8}))" | llm.invoke --provider pi --prompt "Should I wear a jacket?" --disable-cache',
    ctx: {
      env: {
        ...process.env,
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
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
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
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
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

function createMetadataAdapter() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    adapter: {
      source: "test-metadata",
      async invoke({ payload }: { payload: Record<string, unknown> }) {
        calls.push(payload);
        const prompt = String(payload.prompt ?? "");
        const text = /concise title/.test(prompt)
          ? "Weather Summary"
          : "The step summarized the current weather reading.";
        return { ok: true, result: { output: { text, data: null, format: "text" } } };
      },
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

test("metadata:auto resolves in-process via ctx.llmAdapters, writes job title/description, and emits a succeeded metadata checkpoint", async () => {
  const { adapter, calls } = createMetadataAdapter();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir);
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
  const ctx = { cwd: tmpDir, env, llmAdapters: { openclaw: adapter } };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(result.jobId);

  // Resolution used the injected in-process adapter (one call per auto field), no HTTP.
  assert.equal(calls.length, 2);

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title, "Weather Summary");
  assert.equal(job?.description, "The step summarized the current weather reading.");

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const metadataCheckpoint = checkpoints.find(
    (cp) => cp.stepType === "metadata" && cp.status === "succeeded",
  );
  assert.ok(metadataCheckpoint, "expected a succeeded metadata checkpoint");
  assert.equal(metadataCheckpoint?.stepId, "summarize.metadata");
});

test("metadata:auto failure follows the step's default on_error (stop) and errors the run", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const failingAdapter = {
    source: "test-metadata-failing",
    async invoke({ payload }: { payload: Record<string, unknown> }) {
      calls.push(payload);
      throw new Error("llm exploded");
    },
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-fail-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir);
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
  const ctx = { cwd: tmpDir, env, llmAdapters: { openclaw: failingAdapter } };

  const result = await runToolRequest({ filePath, ctx });
  // Default on_error is "stop": the metadata failure halts the run like any step failure.
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /llm exploded/);
  assert.ok(calls.length >= 1);
});

test("metadata:auto failure with on_error continue records a scoped failed checkpoint and finishes the run", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const failingAdapter = {
    source: "test-metadata-failing",
    async invoke({ payload }: { payload: Record<string, unknown> }) {
      calls.push(payload);
      throw new Error("llm exploded");
    },
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-cont-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir, { onError: "continue" });
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
  const ctx = { cwd: tmpDir, env, llmAdapters: { openclaw: failingAdapter } };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(calls.length >= 1);

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title ?? null, null);
  assert.equal(job?.description ?? null, null);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const failed = checkpoints.find((cp) => cp.stepType === "metadata" && cp.status === "failed");
  assert.ok(failed, "expected a failed metadata checkpoint");
  assert.equal(failed?.stepId, "summarize.metadata");
  assert.ok(
    !checkpoints.some((cp) => cp.stepType === "metadata" && cp.status === "succeeded"),
    "no succeeded metadata checkpoint should be recorded on failure",
  );
});

test("metadata:auto empty output is a failure (metadata_generation_empty), not a silent no-op", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const emptyAdapter = {
    source: "test-metadata-empty",
    async invoke({ payload }: { payload: Record<string, unknown> }) {
      calls.push(payload);
      return { ok: true, result: { output: { text: "", data: null, format: "text" } } };
    },
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-empty-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir, { onError: "continue" });
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
  const ctx = { cwd: tmpDir, env, llmAdapters: { openclaw: emptyAdapter } };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(calls.length >= 1);

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title ?? null, null);
  assert.equal(job?.description ?? null, null);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const failed = checkpoints.find((cp) => cp.stepType === "metadata" && cp.status === "failed");
  assert.ok(failed, "expected a failed metadata checkpoint");
  assert.equal(failed?.stepId, "summarize.metadata");
  assert.equal((failed?.metadata as { reason?: string } | undefined)?.reason, "metadata_generation_empty");
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
  const hangingAdapter = {
    source: "test-metadata-hang",
    invoke: () => new Promise<never>(() => {}),
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-metadata-timeout-"));
  const filePath = await writeAutoMetadataWorkflow(tmpDir, { onError: "continue" });
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
    LOBSTER_METADATA_TIMEOUT_MS: "300",
  };
  const ctx = { cwd: tmpDir, env, llmAdapters: { openclaw: hangingAdapter } };

  const result = await runToolRequest({ filePath, ctx });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");

  const job = await getJob({ jobId: result.jobId!, ctx });
  assert.equal(job?.title ?? null, null);
  assert.equal(job?.description ?? null, null);

  const checkpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx });
  const failed = checkpoints.find((cp) => cp.stepType === "metadata" && cp.status === "failed");
  assert.ok(failed, "expected a failed metadata checkpoint");
  assert.equal(failed?.stepId, "summarize.metadata");
  assert.equal(
    (failed?.metadata as { reason?: string } | undefined)?.reason,
    "metadata_generation_failed",
  );
});
