import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getJob, getRun, listJobSteps, runToolRequest } from "../src/core/index.js";
import { aggregateCheckpointUsage, foldCheckpointsIntoSteps } from "../src/store/runtime_store.js";
import type { CheckpointRecord } from "../src/workflows/checkpoints.js";

function checkpoint(
  partial: Partial<CheckpointRecord> & { checkpointId: string; seq: number },
): CheckpointRecord {
  return {
    jobId: "job_1",
    runId: "run_1",
    rootRunId: "run_1",
    kind: "step",
    name: "shell",
    status: "succeeded",
    createdAt: new Date(partial.seq * 1000).toISOString(),
    ...partial,
  } as CheckpointRecord;
}

test("aggregateCheckpointUsage sums metadata.usage across checkpoints", () => {
  const usage = aggregateCheckpointUsage([
    checkpoint({
      checkpointId: "cp_1",
      seq: 1,
      stepPath: "root.a",
      metadata: { usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: 0.001 } },
    }),
    checkpoint({ checkpointId: "cp_2", seq: 2, stepPath: "root.b", metadata: { stepResult: {} } }),
    checkpoint({
      checkpointId: "cp_3",
      seq: 3,
      stepPath: "root.c",
      kind: "detail",
      name: "metadata",
      metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.0002 } },
    }),
  ]);
  assert.ok(usage);
  assert.equal(usage!.inputTokens, 110);
  assert.equal(usage!.outputTokens, 45);
  assert.equal(usage!.totalTokens, 155);
  assert.equal(usage!.costUsd, 0.0012);
});

test("aggregateCheckpointUsage returns undefined when no usage is present", () => {
  const usage = aggregateCheckpointUsage([
    checkpoint({ checkpointId: "cp_1", seq: 1, stepPath: "root.a", metadata: { stepResult: {} } }),
  ]);
  assert.equal(usage, undefined);
});

test("foldCheckpointsIntoSteps attributes usage to the owning step (boundary + detail)", () => {
  const steps = foldCheckpointsIntoSteps([
    checkpoint({
      checkpointId: "cp_boundary",
      seq: 1,
      stepId: "gen",
      stepPath: "root.gen",
      stepIndex: 0,
      metadata: { usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: 0.001 } },
    }),
    checkpoint({
      checkpointId: "cp_detail",
      seq: 2,
      stepId: "gen",
      stepPath: "root.gen",
      stepIndex: 0,
      kind: "detail",
      name: "metadata",
      metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.0002 } },
    }),
  ]);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.usage, {
    inputTokens: 110,
    outputTokens: 45,
    totalTokens: 155,
    costUsd: 0.0012,
  });
});

test("getJob/getRun/listJobSteps expose real LLM usage end-to-end", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-usage-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "llm",
            command:
              "node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:500},output:{text:'hi'}}))\"",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  const run = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(run.status, "ok");
  assert.ok(run.jobId);
  assert.ok(run.runId);

  const job = await getJob({ jobId: run.jobId!, ctx: { env } });
  assert.ok(job?.usage, "job usage should be present");
  assert.equal(job!.usage!.inputTokens, 1000);
  assert.equal(job!.usage!.outputTokens, 500);
  assert.equal(job!.usage!.totalTokens, 1500);
  assert.equal(job!.usage!.costUsd, 0.0075);

  const runRecord = await getRun({ runId: run.runId!, ctx: { env } });
  assert.equal(runRecord?.usage?.totalTokens, 1500);

  const steps = await listJobSteps({ jobId: run.jobId!, ctx: { env } });
  const llmStep = steps.find((s) => s.stepId === "llm");
  assert.ok(llmStep?.usage, "llm step usage should be present");
  assert.equal(llmStep!.usage!.totalTokens, 1500);
});
