import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resumeToolRequest, runToolRequest } from "../src/core/index.js";
import { getJob, getRun } from "../src/store/runtime_store.js";
import { withRuntimeDb } from "../src/store/sqlite.js";

async function writeWorkflows(tmpDir: string, files: Record<string, unknown>) {
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(tmpDir, name), JSON.stringify(content, null, 2), "utf8");
  }
}

test("nested approval bubbles up through the tool envelope and resumes to completion", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-approve-"));
  await writeWorkflows(tmpDir, {
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster" }],
    },
  });

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const first = await runToolRequest({
    filePath: path.join(tmpDir, "parent.lobster"),
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.jobId);
  assert.ok(first.runId);
  assert.ok(first.requiresApproval?.resumeToken);

  // Root job and root run should both be parked in a waiting state.
  const waitingJob = await getJob(env, first.jobId!);
  assert.equal(waitingJob?.status, "waiting");
  const waitingRun = await getRun(env, first.runId!);
  assert.equal(waitingRun?.status, "waiting");

  const resumed = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: true,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ v: 1 }]);
  assert.equal(resumed.jobId, first.jobId);

  const doneJob = await getJob(env, first.jobId!);
  assert.equal(doneJob?.status, "succeeded");
});

test("nested approval reject through the tool envelope cancels the job and records a rejection", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-reject-"));
  await writeWorkflows(tmpDir, {
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster" }],
    },
  });

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const first = await runToolRequest({
    filePath: path.join(tmpDir, "parent.lobster"),
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "needs_approval");

  const rejected = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: false,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rejected.status, "cancelled");

  const job = await getJob(env, first.jobId!);
  assert.equal(job?.status, "cancelled");

  const approvals = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare("SELECT status, decision FROM approvals WHERE job_id = ?")
        .all(first.jobId) as Array<{ status: string; decision: string | null }>,
  );
  assert.ok(approvals.length >= 1);
  assert.ok(
    approvals.some((row) => row.status === "rejected" && row.decision === "reject"),
    `expected a rejected approval, saw ${JSON.stringify(approvals)}`,
  );
});
