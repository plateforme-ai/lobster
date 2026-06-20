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

  const first = await runToolRequest({
    filePath: parentPath,
    stepMode: true,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.jobId);
  assert.ok(first.runId);

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
