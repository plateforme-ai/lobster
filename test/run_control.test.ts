import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cancelRun,
  getJob,
  listJobCheckpoints,
  listJobs,
  listPendingApprovals,
  pauseRun,
  resumeToolRequest,
  runToolRequest,
  setJobExternalSession,
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

async function writeApprovalWorkflow(tmpDir: string) {
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "work", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          {
            id: "gate",
            approval: true,
            run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"',
          },
          { id: "after", run: 'node -e "process.stdout.write(JSON.stringify({n:3}))"' },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

async function writeInputWorkflow(tmpDir: string) {
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "work", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          {
            id: "ask",
            input: {
              prompt: "How many?",
              responseSchema: {
                type: "object",
                properties: { count: { type: "number" } },
                required: ["count"],
              },
            },
          },
          { id: "after", run: 'node -e "process.stdout.write(JSON.stringify({n:3}))"' },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

async function writeSlowFirstStepWorkflow(tmpDir: string) {
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "slow",
            run: 'node -e "setTimeout(()=>process.stdout.write(JSON.stringify({n:1})),1500)"',
          },
          { id: "two", run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"' },
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
    LOBSTER_DIR: tmpDir,
  };
}

test("step mode pauses before each step and continues to completion", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  // Fresh run pauses before the first step, having executed nothing.
  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.equal(first.paused?.reason, "step_mode");
  assert.equal(first.paused?.stepIndex, 0);
  assert.ok(first.paused?.resumeToken);

  const second = await resumeToolRequest({ token: first.paused!.resumeToken, ctx });
  assert.equal(second.status, "paused");
  assert.equal(second.paused?.stepIndex, 1);

  const third = await resumeToolRequest({ token: second.paused!.resumeToken, ctx });
  assert.equal(third.status, "paused");
  assert.equal(third.paused?.stepIndex, 2);

  const fourth = await resumeToolRequest({ token: third.paused!.resumeToken, ctx });
  assert.equal(fourth.status, "ok");
  assert.deepEqual(fourth.output, [{ n: 3 }]);
  assert.equal(fourth.jobId, first.jobId);
});

test("step mode pauses before the first step of a nested workflow too", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-"));
  const childPath = path.join(tmpDir, "child.lobster");
  const parentPath = path.join(tmpDir, "parent.lobster");
  await fsp.writeFile(
    childPath,
    JSON.stringify(
      {
        steps: [
          { id: "childOne", run: 'node -e "process.stdout.write(JSON.stringify({c:1}))"' },
          { id: "childTwo", run: 'node -e "process.stdout.write(JSON.stringify({c:2}))"' },
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
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  // Fresh run pauses before the parent's first step (the nested workflow call).
  const first = await runToolRequest({ filePath: parentPath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.equal(first.paused?.reason, "step_mode");
  assert.equal(first.paused?.stepIndex, 0);

  // Resuming enters the child, which pauses before its own first step rather than
  // running it straight through.
  const enteredChild = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(enteredChild.status, "paused");
  assert.equal(enteredChild.paused?.reason, "step_mode");
  assert.equal(enteredChild.paused?.stepIndex, 0);

  // Each further resume advances exactly one child step, then the composition completes.
  const childOne = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(childOne.status, "paused");
  assert.equal(childOne.paused?.stepIndex, 1);

  const done = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(done.status, "ok");
});

test("cancel at a pause gate takes effect immediately with a terminal checkpoint", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cancel-pause-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  const cancelEnvelope = await cancelRun({ jobId: first.jobId!, ctx });
  assert.equal(cancelEnvelope.ok, true);
  assert.equal(cancelEnvelope.status, "cancelled");

  // Immediate: no resume needed. The job is cancelled and head wait is cleared.
  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.status, "cancelled");
  assert.equal(job?.wait, null);
  assert.equal(job?.control.desired, "none");

  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  assert.ok(
    checkpoints.some((cp) => cp.name === "pause" && cp.status === "cancelled"),
    "head pause checkpoint should be transitioned to cancelled",
  );
  assert.ok(
    checkpoints.some((cp) => cp.name === "cancel" && cp.status === "cancelled"),
    "a terminal cancel checkpoint should be appended",
  );
});

test("cancel at an approval gate cancels immediately and drops the pending approval", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cancel-approval-"));
  const filePath = await writeApprovalWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.jobId);

  const before = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(before?.wait?.kind, "approval");

  const cancelEnvelope = await cancelRun({ jobId: first.jobId!, ctx });
  assert.equal(cancelEnvelope.status, "cancelled");

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.status, "cancelled");
  assert.equal(job?.wait, null);

  const { approvals } = await listPendingApprovals({ jobId: first.jobId!, ctx });
  assert.equal(approvals.length, 0);

  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  assert.ok(checkpoints.some((cp) => cp.name === "cancel" && cp.status === "cancelled"));
});

test("cancel at an input gate cancels immediately with a terminal checkpoint", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cancel-input-"));
  const filePath = await writeInputWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_input");

  const cancelEnvelope = await cancelRun({ jobId: first.jobId!, ctx });
  assert.equal(cancelEnvelope.status, "cancelled");

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.status, "cancelled");
  assert.equal(job?.wait, null);

  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  assert.ok(
    checkpoints.some((cp) => cp.name === "input" && cp.status === "cancelled"),
    "head input checkpoint should be transitioned to cancelled",
  );
  assert.ok(checkpoints.some((cp) => cp.name === "cancel" && cp.status === "cancelled"));
});

test("cancel mid-step is cooperative: desired=cancel then cancelled at the next boundary", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cancel-midstep-"));
  const filePath = await writeSlowFirstStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const runPromise = runToolRequest({ filePath, ctx });
  // Let the slow step enter flight.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const { jobs } = await listJobs({ ctx });
  const running = jobs.find((entry) => entry.status === "running");
  assert.ok(running, "expected a running job to target");

  const cancelEnvelope = await cancelRun({ jobId: running!.jobId, ctx });
  assert.equal(cancelEnvelope.ok, true);
  assert.equal(cancelEnvelope.status, "ok");

  const job = await getJob({ jobId: running!.jobId, ctx });
  assert.equal(job?.control.desired, "cancel");

  const result = await runPromise;
  assert.equal(result.status, "cancelled");

  const finalJob = await getJob({ jobId: running!.jobId, ctx });
  assert.equal(finalJob?.status, "cancelled");

  const checkpoints = await listJobCheckpoints({ jobId: running!.jobId, ctx });
  assert.ok(checkpoints.some((cp) => cp.name === "cancel" && cp.status === "cancelled"));
});

test("approval reject appends a terminal control/cancelled checkpoint", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-reject-checkpoint-"));
  const filePath = await writeApprovalWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_approval");

  const rejected = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: false,
    ctx,
  });
  assert.equal(rejected.status, "cancelled");

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.status, "cancelled");

  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  assert.ok(
    checkpoints.some((cp) => cp.name === "cancel" && cp.status === "cancelled"),
    "approval reject should append a terminal cancel checkpoint",
  );
});

test("explicit pause is honored at the next step boundary", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pause-"));
  const filePath = await writeSlowFirstStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const runPromise = runToolRequest({ filePath, ctx });
  // Let the slow step enter flight.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const { jobs } = await listJobs({ ctx });
  const running = jobs.find((entry) => entry.status === "running");
  assert.ok(running, "expected a running job to target");

  const pauseEnvelope = await pauseRun({ jobId: running!.jobId, ctx });
  assert.equal(pauseEnvelope.ok, true);
  assert.equal(pauseEnvelope.status, "ok");

  const job = await getJob({ jobId: running!.jobId, ctx });
  assert.equal(job?.control.desired, "pause");

  const first = await runPromise;
  assert.equal(first.status, "paused");
  assert.equal(first.paused?.reason, "pause_requested");

  // Pause is one-shot: the next resume runs to completion.
  const second = await resumeToolRequest({ token: first.paused!.resumeToken!, ctx });
  assert.equal(second.status, "ok");
  assert.deepEqual(second.output, [{ n: 2 }]);
});

test("pause at an approval gate returns already_waiting without mutating control", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pause-approval-"));
  const filePath = await writeApprovalWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_approval");

  const pauseEnvelope = await pauseRun({ jobId: first.jobId!, ctx });
  assert.equal(pauseEnvelope.ok, false);
  assert.equal(pauseEnvelope.error?.type, "already_waiting");
  assert.match(pauseEnvelope.error?.message ?? "", /waiting on approval/);

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.wait?.kind, "approval");
  assert.equal(job?.control.desired, "none");
});

test("pause at an input gate returns already_waiting without mutating control", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pause-input-"));
  const filePath = await writeInputWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, ctx });
  assert.equal(first.status, "needs_input");

  const pauseEnvelope = await pauseRun({ jobId: first.jobId!, ctx });
  assert.equal(pauseEnvelope.ok, false);
  assert.equal(pauseEnvelope.error?.type, "already_waiting");
  assert.match(pauseEnvelope.error?.message ?? "", /waiting on input/);

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.wait?.kind, "input");
  assert.equal(job?.control.desired, "none");
});

test("pause at a pause gate returns already_waiting without mutating control", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pause-paused-"));
  const filePath = await writeThreeStepWorkflow(tmpDir);
  const env = makeEnv(tmpDir);
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  const pauseEnvelope = await pauseRun({ jobId: first.jobId!, ctx });
  assert.equal(pauseEnvelope.ok, false);
  assert.equal(pauseEnvelope.error?.type, "already_waiting");
  assert.match(pauseEnvelope.error?.message ?? "", /waiting on pause/);

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.wait?.kind, "pause");
  assert.equal(job?.control.desired, "none");
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
    sessionKey: "sess-123",
    provider: "openclaw",
    agentId: "main",
    ctx,
  });
  assert.equal(setEnvelope.ok, true);
  assert.equal(setEnvelope.externalProvider, "openclaw");
  assert.equal(setEnvelope.externalAgentId, "main");
  assert.equal(setEnvelope.externalSessionKey, "sess-123");

  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.externalProvider, "openclaw");
  assert.equal(job?.externalAgentId, "main");
  assert.equal(job?.externalSessionKey, "sess-123");

  const { jobs } = await listJobs({ ctx });
  const listed = jobs.find((entry) => entry.jobId === first.jobId);
  assert.equal(listed?.externalSessionKey, "sess-123");
  assert.equal(listed?.externalAgentId, "main");

  // Subsequent envelopes for this job carry the bound session key.
  const resumed = await resumeToolRequest({ token: first.paused!.resumeToken, ctx });
  assert.equal(resumed.externalProvider, "openclaw");
  assert.equal(resumed.externalAgentId, "main");
  assert.equal(resumed.externalSessionKey, "sess-123");
});
