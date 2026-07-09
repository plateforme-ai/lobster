import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJob,
  listRunCheckpoints,
  rerunToolRequest,
  resumeToolRequest,
  rewindToolRequest,
  runToolRequest,
} from "../src/core/index.js";

test("rerun creates a linked run and rewind creates a child run from checkpoint state", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rerun-rewind-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "one",
            run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"',
          },
          {
            id: "two",
            run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"',
            stdin: "$one.json",
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
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "ok");
  assert.ok(first.jobId);
  assert.ok(first.runId);

  const rerun = await rerunToolRequest({ jobId: first.jobId!, ctx: { cwd: tmpDir, env } });
  assert.equal(rerun.status, "ok");
  assert.ok(rerun.jobId);
  assert.ok(rerun.runId);
  assert.notEqual(rerun.jobId, first.jobId);

  const checkpoints = await listRunCheckpoints({ runId: first.runId!, ctx: { env } });
  const one = checkpoints.find(
    (checkpoint) => checkpoint.stepId === "one" && checkpoint.status === "succeeded",
  );
  assert.ok(one);

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    checkpointId: one!.checkpointId,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.status, "ok");
  assert.ok(rewind.jobId);
  assert.ok(rewind.runId);
  assert.equal(rewind.jobId, first.jobId);
  assert.notEqual(rewind.runId, first.runId);
  assert.deepEqual(rewind.output, [{ n: 2 }]);
});

test("rewind applies per-step input overrides to downstream steps", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rewind-input-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          { id: "two", run: 'node -e "process.stdin.pipe(process.stdout)"', stdin: "$one.json" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "ok");
  assert.deepEqual(first.output, [{ n: 1 }]);

  const checkpoints = await listRunCheckpoints({ runId: first.runId!, ctx: { env } });
  const one = checkpoints.find(
    (checkpoint) => checkpoint.stepId === "one" && checkpoint.status === "succeeded",
  );
  assert.ok(one);

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    checkpointId: one!.checkpointId,
    inputOverride: { one: { json: { n: 99 } } },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.status, "ok");
  assert.deepEqual(rewind.output, [{ n: 99 }]);
});

test("rewind rejects an input override for an unknown step", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rewind-badinput-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [{ id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' }],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  const checkpoints = await listRunCheckpoints({ runId: first.runId!, ctx: { env } });
  const one = checkpoints.find(
    (checkpoint) => checkpoint.stepId === "one" && checkpoint.status === "succeeded",
  );

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    checkpointId: one!.checkpointId,
    inputOverride: { missing: { json: { n: 1 } } },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.ok, false);
  assert.equal((rewind as { error?: { type?: string } }).error?.type, "invalid_input_override");
});

test("resume can edit workflow args via argsPatch", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-args-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        args: { greeting: { default: "hi" } },
        steps: [
          {
            id: "gate",
            run: 'node -e "process.stdout.write(JSON.stringify({ok:1}))"',
            approval: true,
          },
          {
            id: "say",
            run: 'node -e "process.stdout.write(JSON.stringify({g: process.env.LOBSTER_ARG_GREETING}))"',
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
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.requiresApproval?.resumeToken);

  const resumed = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: true,
    argsPatch: { greeting: "bye" },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ g: "bye" }]);
});

test("resume can edit the approved payload (edit-then-approve)", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-approve-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "gate",
            run: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
            approval: true,
          },
          {
            id: "use",
            run: 'node -e "process.stdin.pipe(process.stdout)"',
            stdin: "$gate.json",
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
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "needs_approval");

  const resumed = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: true,
    approvedPayloadOverride: { v: 42 },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ v: 42 }]);
});

test("rerun and rewind copy job title, description, and metadata", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rerun-metadata-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "one",
            run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"',
          },
          {
            id: "two",
            run: 'node -e "process.stdout.write(JSON.stringify({n:2}))"',
            stdin: "$one.json",
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
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({
    filePath,
    title: "Original run",
    description: "First attempt",
    metadata: { attempt: 1 },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "ok");

  const rerun = await rerunToolRequest({ jobId: first.jobId!, ctx: { cwd: tmpDir, env } });
  assert.equal(rerun.status, "ok");
  const rerunJob = await getJob({ jobId: rerun.jobId!, ctx: { env } });
  assert.equal(rerunJob?.title, "Original run");
  assert.equal(rerunJob?.description, "First attempt");
  assert.deepEqual(rerunJob?.metadata, { attempt: 1 });

  const checkpoints = await listRunCheckpoints({ runId: first.runId!, ctx: { env } });
  const one = checkpoints.find(
    (checkpoint) => checkpoint.stepId === "one" && checkpoint.status === "succeeded",
  );
  assert.ok(one);

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    checkpointId: one!.checkpointId,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.status, "ok");
  const rewindJob = await getJob({ jobId: rewind.jobId!, ctx: { env } });
  assert.equal(rewindJob?.title, "Original run");
  assert.equal(rewindJob?.description, "First attempt");
  assert.deepEqual(rewindJob?.metadata, { attempt: 1 });
});
