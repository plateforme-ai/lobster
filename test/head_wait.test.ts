import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJob,
  listJobCheckpoints,
  listPendingApprovals,
  resumeToolRequest,
  runToolRequest,
} from "../src/core/index.js";
import { createApprovalRecord } from "../src/store/runtime_store.js";

function makeEnv(tmpDir: string) {
  return {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
}

async function writeThreeStepWorkflow(tmpDir: string) {
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          { id: "two", run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"' },
          { id: "three", run: 'node -e "process.stdout.write(JSON.stringify({n:3}))"' },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

async function writeApprovalWorkflow(tmpDir: string) {
  const filePath = path.join(tmpDir, "approval.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "review",
            run: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"',
            approval: true,
          },
          { id: "done", run: 'node -e "process.stdout.write(JSON.stringify({done:true}))"' },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

test("job-scoped continue advances only the head pause", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-head-pause-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  const firstJob = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(firstJob?.wait?.kind, "pause");
  assert.equal(firstJob?.wait?.checkpointId, first.latestCheckpointId);

  const second = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.stepIndex, 2);

  const afterSecond = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  const pauseCheckpoints = afterSecond.filter((checkpoint) => checkpoint.stepType === "pause");
  assert.deepEqual(
    pauseCheckpoints.map((checkpoint) => checkpoint.status),
    ["resumed", "waiting"],
  );

  const third = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(third.status, "ok");
  assert.deepEqual(third.output, [{ n: 3 }]);

  const finalCheckpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  assert.deepEqual(
    finalCheckpoints
      .filter((checkpoint) => checkpoint.stepType === "pause")
      .map((checkpoint) => checkpoint.status),
    ["resumed", "resumed"],
  );
});

test("stale approval does not intercept job-scoped continue when head is pause", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-head-stale-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  await createApprovalRecord({
    env,
    approvalId: "stale-approval",
    jobId: first.jobId,
    runId: first.runId,
    rootRunId: first.rootRunId,
    stateKey: "workflow_resume_stale",
    prompt: "Stale approval?",
  });

  const pending = await listPendingApprovals({ jobId: first.jobId!, ctx });
  assert.equal(pending.approvals.length, 0);

  const second = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.stepIndex, 2);
});

test("head approval blocks continue and resumes by approval id", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-head-approval-"));
  const filePath = await writeApprovalWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.requiresApproval?.approvalId);

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.wait?.kind, "approval");
  assert.equal(job?.wait?.approvalId, first.requiresApproval.approvalId);

  const blocked = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.type, "no_resumable_state");
  assert.match(blocked.error?.message ?? "", /waiting on approval, not paused/);

  const pending = await listPendingApprovals({ jobId: first.jobId!, ctx });
  assert.equal(pending.approvals.length, 1);
  assert.equal(pending.approvals[0].approvalId, first.requiresApproval.approvalId);

  const resumed = await resumeToolRequest({
    approvalId: first.requiresApproval.approvalId,
    approved: true,
    ctx,
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ done: true }]);
});
