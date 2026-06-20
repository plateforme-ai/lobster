import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cancelRun,
  getJob,
  listJobs,
  pauseRun,
  resumeToolRequest,
  runToolRequest,
  setJobExternalSession,
  setStepMode,
} from "../src/core/index.js";

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

function makeEnv(tmpDir: string) {
  return {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };
}

test("step mode pauses after each step and continues to completion", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-stepmode-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.equal(first.paused?.reason, "step_mode");
  assert.equal(first.paused?.stepIndex, 1);
  assert.ok(first.paused?.resumeToken);

  const second = await resumeToolRequest({ token: first.paused!.resumeToken, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.stepIndex, 2);

  const third = await resumeToolRequest({ token: second.paused!.resumeToken, ctx });
  assert.equal(third.status, "ok");
  assert.deepEqual(third.output, [{ n: 3 }]);
  assert.equal(third.jobId, first.jobId);
});

test("cancel is honored when a paused run resumes", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cancel-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  const cancelEnvelope = await cancelRun({ jobId: first.jobId!, ctx });
  assert.equal(cancelEnvelope.ok, true);

  const resumed = await resumeToolRequest({ token: first.paused!.resumeToken, ctx });
  assert.equal(resumed.status, "cancelled");
});

test("explicit pause is honored at the next step boundary", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pause-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  // Start in step mode so we get a handle (jobId + resume token) without
  // running to completion synchronously.
  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  // Turn off step mode, then request a one-shot pause.
  await setStepMode({ jobId: first.jobId!, stepMode: false, ctx });
  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.control.stepMode, false);
  await pauseRun({ jobId: first.jobId!, ctx });

  const second = await resumeToolRequest({ token: first.paused!.resumeToken, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.reason, "pause_requested");

  // Pause is one-shot: the next resume runs to completion.
  const third = await resumeToolRequest({ token: second.paused!.resumeToken, ctx });
  assert.equal(third.status, "ok");
  assert.deepEqual(third.output, [{ n: 3 }]);
});

test("external session id round-trips through the store and run envelopes", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-session-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.ok(first.jobId);

  const setEnvelope = await setJobExternalSession({
    jobId: first.jobId!,
    sessionId: "sess-123",
    provider: "openclaw",
    ctx,
  });
  assert.equal(setEnvelope.ok, true);
  assert.equal(setEnvelope.externalSessionId, "sess-123");

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.externalSessionId, "sess-123");
  assert.equal(job?.externalSessionProvider, "openclaw");

  const { jobs } = await listJobs({ ctx });
  const listed = jobs.find((entry) => entry.jobId === first.jobId);
  assert.equal(listed?.externalSessionId, "sess-123");

  // Subsequent envelopes for this job carry the bound session id.
  const resumed = await resumeToolRequest({ token: first.paused!.resumeToken, ctx });
  assert.equal(resumed.externalSessionId, "sess-123");
});
