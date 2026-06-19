import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resumeToolRequest, runToolRequest, setJobExternalSession } from "../src/core/index.js";

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
      LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
      LOBSTER_CHECKPOINTS_ENABLED: "true",
    },
  };

  // Pause after step one (step mode), bind a session + agent + model, then resume.
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
    sessionId: "lobster:job:abc",
    provider: "openclaw",
    ctx,
  });

  const done = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ sess: "lobster:job:abc", agent: "researcher", model: "gpt-5" }]);
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
      LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
      LOBSTER_CHECKPOINTS_ENABLED: "true",
    },
  };

  const first = await runToolRequest({ filePath, stepMode: true, ctx });
  assert.equal(first.status, "paused");

  await setJobExternalSession({
    jobId: first.jobId!,
    sessionId: "lobster:job:abc",
    provider: "openclaw",
    ctx,
  });

  const done = await resumeToolRequest({ jobId: first.jobId!, ctx });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ sess: "explicit-session" }]);
});
