import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJob,
  listJobCheckpoints,
  resumeToolRequest,
  runToolRequest,
  setJobExternalSession,
} from "../src/core/index.js";

// Feature 2: in-workflow steps default to the job's session/agent/model. The
// values are injected into the base step env by runWorkflowFile, so a plain
// `run` step (and therefore openclaw.invoke / llm.invoke, via fallback) observes
// them when not set explicitly.
test("job session/agent/model are injected into the step env on resume", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-job-env-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          {
            id: "two",
            run:
              'node -e "process.stdout.write(JSON.stringify({' +
              "sess: process.env.LOBSTER_JOB_SESSION_KEY ?? null," +
              "agent: process.env.LOBSTER_JOB_AGENT ?? null," +
              "model: process.env.LOBSTER_JOB_MODEL ?? null}))" +
              '"',
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const ctx = {
    cwd: tmpDir,
    env: {
      ...process.env,
      LOBSTER_DIR: tmpDir,
    },
  };

  // Pause before the first step (step mode), bind a session + agent + model, then resume.
  const first = await runToolRequest({
    filePath,
    stepMode: true,
    agent: "researcher",
    model: "gpt-5",
    ctx,
  });
  assert.equal(first.status, "paused");
  assert.ok(first.jobId);

  await setJobExternalSession({
    jobId: first.jobId!,
    sessionKey: "lobster:abc",
    provider: "openclaw",
    agentId: "main",
    ctx,
  });

  // First resume runs step one; a second resume runs step two which reads the injected env.
  const afterOne = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(afterOne.status, "paused");
  const done = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ sess: "lobster:abc", agent: "researcher", model: "gpt-5" }]);
});

test("explicit step env still wins over the injected job session", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-job-env-explicit-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          {
            id: "two",
            env: { LOBSTER_JOB_SESSION_KEY: "explicit-session" },
            run:
              'node -e "process.stdout.write(JSON.stringify({' +
              "sess: process.env.LOBSTER_JOB_SESSION_KEY ?? null}))" +
              '"',
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const ctx = {
    cwd: tmpDir,
    env: {
      ...process.env,
      LOBSTER_DIR: tmpDir,
    },
  };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  await setJobExternalSession({
    jobId: first.jobId!,
    sessionKey: "lobster:abc",
    provider: "openclaw",
    agentId: "main",
    ctx,
  });

  // First resume runs step one; a second resume runs step two.
  const afterOne = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(afterOne.status, "paused");
  const done = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ sess: "explicit-session" }]);
});

// Contract locked for the OpenClaw plugin's job-authoritative session mirroring: once a job is bound,
// both the advance (continue) envelope and getJob must surface externalProvider/externalAgentId/
// externalSessionKey, and listJobCheckpoints must reflect the advance synchronously.
test("continue envelope and getJob carry the external session identity, checkpoints are synchronous", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-job-mirror-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          { id: "two", run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"' },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const ctx = {
    cwd: tmpDir,
    env: {
      ...process.env,
      LOBSTER_DIR: tmpDir,
    },
  };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");
  assert.ok(first.jobId);

  await setJobExternalSession({
    jobId: first.jobId!,
    sessionKey: "lobster:xyz",
    provider: "openclaw",
    agentId: "main",
    sessionId: "session-xyz",
    ctx,
  });

  // Advance one step. The paused/ok envelope must carry the bound identity (sessionExtraForRun).
  const advanced = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(advanced.externalProvider, "openclaw");
  assert.equal(advanced.externalAgentId, "main");
  assert.equal(advanced.externalSessionId, "session-xyz");
  assert.equal(advanced.externalSessionKey, "lobster:xyz");

  // getJob must surface the same identity (the plugin resolves the mirror target solely from this,
  // including the sessionId that locates the transcript file).
  const job = await getJob({ jobId: first.jobId!, ctx });
  assert.equal(job?.externalProvider, "openclaw");
  assert.equal(job?.externalAgentId, "main");
  assert.equal(job?.externalSessionId, "session-xyz");
  assert.equal(job?.externalSessionKey, "lobster:xyz");

  // Checkpoints created by the advance are visible synchronously after it returns.
  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  assert.ok(Array.isArray(checkpoints));
  assert.ok(checkpoints.length >= 1);
});
