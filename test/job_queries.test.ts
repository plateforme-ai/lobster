import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJob,
  getRun,
  listJobRuns,
  listJobs,
  listPendingApprovals,
  resumeToolRequest,
  runToolRequest,
} from "../src/core/index.js";

test("public core query APIs expose job, nested runs, and pending approvals", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-job-queries-"));
  const childPath = path.join(tmpDir, "child.lobster");
  const parentPath = path.join(tmpDir, "parent.lobster");
  await fsp.writeFile(
    childPath,
    JSON.stringify(
      {
        name: "named-child",
        steps: [
          {
            id: "review",
            command: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"',
            approval: true,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fsp.writeFile(
    parentPath,
    JSON.stringify(
      {
        steps: [{ id: "callChild", workflow: "child.lobster" }],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  // Step mode pauses before the parent's first step. Advance through the parent
  // entry pause and the child's entry pause to reach the nested approval gate,
  // which also verifies step mode propagates into the child run.
  const first = await runToolRequest({
    filePath: parentPath,
    stepMode: true,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "paused");
  assert.ok(first.jobId);
  assert.ok(first.runId);

  const enteredChild = await resumeToolRequest({ jobId: first.jobId!, ctx: { cwd: tmpDir, env } });
  assert.equal(enteredChild.status, "paused");

  const atApproval = await resumeToolRequest({ jobId: first.jobId!, ctx: { cwd: tmpDir, env } });
  assert.equal(atApproval.status, "needs_approval");

  const job = await getJob({ jobId: first.jobId!, ctx: { env } });
  assert.equal(job?.jobId, first.jobId);
  assert.equal(job?.status, "waiting");
  assert.equal(job?.control.stepMode, true);
  assert.equal(job?.control.desired, "none");
  assert.equal(job?.wait?.kind, "approval");
  assert.equal(job?.wait?.stepId, "callChild");

  const rootRun = await getRun({ runId: first.runId!, ctx: { env } });
  assert.equal(rootRun?.runId, first.runId);
  assert.equal(rootRun?.depth, 0);
  assert.equal(rootRun?.workflowName, "parent");
  assert.equal(rootRun?.control.stepMode, true);
  assert.equal(rootRun?.control.desired, "none");

  const runs = await listJobRuns({ jobId: first.jobId!, ctx: { env } });
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((run) => run.depth),
    [0, 1],
  );
  assert.equal(runs[1].parentRunId, first.runId);
  assert.equal(runs[1].parentStepId, "callChild");
  assert.equal(runs[1].workflowName, "named-child");
  assert.deepEqual(
    runs.map((run) => run.control),
    [
      { stepMode: true, desired: "none", updatedAt: job?.control.updatedAt },
      { stepMode: true, desired: "none", updatedAt: job?.control.updatedAt },
    ],
  );

  const waitingJobs = await listJobs({ status: "waiting", limit: 10, ctx: { env } });
  const waitingJob = waitingJobs.jobs.find((item) => item.jobId === first.jobId);
  assert.ok(waitingJob);
  assert.equal(waitingJob.control.stepMode, true);
  assert.equal(waitingJob.control.desired, "none");
  assert.equal(waitingJob.wait?.kind, "approval");
  assert.equal(waitingJobs.nextCursor, null);

  const approvals = await listPendingApprovals({ jobId: first.jobId!, ctx: { env } });
  assert.equal(approvals.approvals.length, 1);
  assert.equal(approvals.approvals[0].jobId, first.jobId);
  assert.equal(approvals.approvals[0].runId, runs[1].runId);
  assert.equal(approvals.approvals[0].prompt, "Approve review?");
});

test("pipeline run records do not set workflowName", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pipeline-run-name-"));
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const result = await runToolRequest({ pipeline: "json", ctx: { cwd: tmpDir, env } });
  assert.equal(result.status, "ok");
  assert.ok(result.runId);

  const run = await getRun({ runId: result.runId!, ctx: { env } });
  assert.equal(run?.sourceType, "pipeline");
  assert.equal(run?.workflowName, null);
});

test("runToolRequest persists job title, description, and metadata", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-job-metadata-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "one",
            run: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"',
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
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const result = await runToolRequest({
    filePath,
    title: "Deploy check",
    description: "Validate release candidate",
    metadata: { env: "staging", pr: 42 },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(result.status, "ok");
  assert.ok(result.jobId);

  const job = await getJob({ jobId: result.jobId!, ctx: { env } });
  assert.equal(job?.title, "Deploy check");
  assert.equal(job?.description, "Validate release candidate");
  assert.deepEqual(job?.metadata, { env: "staging", pr: 42 });

  const { jobs } = await listJobs({ ctx: { env } });
  const listed = jobs.find((entry) => entry.jobId === result.jobId);
  assert.equal(listed?.title, "Deploy check");
  assert.deepEqual(listed?.metadata, { env: "staging", pr: 42 });
});

test("runToolRequest rejects invalid metadata", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-job-metadata-invalid-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({ steps: [{ id: "one", run: "node -e \"process.stdout.write('{}')\"" }] }),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const arrayResult = await runToolRequest({
    filePath,
    metadata: ["not", "an", "object"] as unknown as Record<string, unknown>,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(arrayResult.ok, false);
  assert.equal(arrayResult.error?.type, "parse_error");

  const titleResult = await runToolRequest({
    filePath,
    title: 123 as unknown as string,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(titleResult.ok, false);
  assert.equal(titleResult.error?.type, "parse_error");
});
