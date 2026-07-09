import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resumeToolRequest, runToolRequest } from "../src/core/index.js";

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
            id: "gated",
            command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
            approval: true,
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

function makeEnv(tmpDir: string) {
  return {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
}

test("resume by jobId advances the latest paused run", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-jobid-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const ctx = { cwd: tmpDir, env: makeEnv(tmpDir) };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.ok(first.jobId);

  const second = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.stepIndex, 1);
  assert.equal(second.jobId, first.jobId);

  const third = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(third.status, "paused");
  assert.equal(third.paused?.stepIndex, 2);

  const fourth = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(fourth.status, "ok");
  assert.deepEqual(fourth.output, [{ n: 3 }]);
});

test("resume by runId advances the latest paused run", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-runid-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const ctx = { cwd: tmpDir, env: makeEnv(tmpDir) };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.ok(first.runId);

  const second = await resumeToolRequest({ runId: first.runId!, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.stepIndex, 1);
});

test("resume by jobId returns no_resumable_state when nothing is waiting", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-none-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const ctx = { cwd: tmpDir, env: makeEnv(tmpDir) };

  // Run to completion (no step mode), so there is no waiting state.
  const done = await runToolRequest({ filePath, ctx });
  assert.equal(done.status, "ok");
  assert.ok(done.jobId);

  const resumed = (await resumeToolRequest({ jobId: done.jobId!, ctx })) as {
    ok: boolean;
    error?: { type?: string };
  };
  assert.equal(resumed.ok, false);
  assert.equal(resumed.error?.type, "no_resumable_state");
});

test("approval gate is resumable by jobId", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-approval-"));
  const filePath = await writeApprovalWorkflow(tmpDir);
  const ctx = { cwd: tmpDir, env: makeEnv(tmpDir) };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.jobId);

  const resumed = await resumeToolRequest({ jobId: first.jobId!, approved: true, ctx });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ v: 1 }]);
  assert.equal(resumed.jobId, first.jobId);
});
