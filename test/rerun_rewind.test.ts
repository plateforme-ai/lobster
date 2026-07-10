import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJob,
  listRunCheckpoints,
  listRunSteps,
  rerunToolRequest,
  resumeToolRequest,
  rewindToolRequest,
  runToolRequest,
} from "../src/core/index.js";

test("rerun creates a linked run and rewind re-executes the target step in a new run", async () => {
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

  // Rewinding to the first step re-executes it (and everything after) in the new
  // run, rather than resuming after it.
  const rewoundSteps = await listRunSteps({ runId: rewind.runId!, ctx: { env } });
  const rewoundOne = rewoundSteps.find((step) => step.stepId === "one");
  const rewoundTwo = rewoundSteps.find((step) => step.stepId === "two");
  assert.ok(rewoundOne, "target step should re-execute in the rewind run");
  assert.equal(rewoundOne!.status, "succeeded");
  assert.ok(rewoundTwo, "downstream steps should re-execute in the rewind run");
  assert.equal(rewoundTwo!.status, "succeeded");
});

test("rewind preserves prefix steps and re-executes the target plus downstream", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rewind-prefix-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
          { id: "two", run: 'node -e "process.stdin.pipe(process.stdout)"', stdin: "$one.json" },
          { id: "three", run: 'node -e "process.stdin.pipe(process.stdout)"', stdin: "$two.json" },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "ok");
  assert.deepEqual(first.output, [{ n: 1 }]);

  const steps = await listRunSteps({ runId: first.runId!, ctx: { env } });
  const two = steps.find((step) => step.stepId === "two");
  assert.ok(two);

  // Rewind to `two`: `one` is preserved as the prefix, `two` and `three`
  // re-execute.
  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    stepPath: two!.stepPath,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.status, "ok");
  assert.deepEqual(rewind.output, [{ n: 1 }]);

  const rewoundSteps = await listRunSteps({ runId: rewind.runId!, ctx: { env } });
  // Only the target and downstream steps run in the new run; the preserved
  // prefix step `one` is not re-recorded.
  assert.equal(
    rewoundSteps.find((step) => step.stepId === "one"),
    undefined,
    "prefix step should be preserved, not re-executed",
  );
  assert.equal(rewoundSteps.find((step) => step.stepId === "two")?.status, "succeeded");
  assert.equal(rewoundSteps.find((step) => step.stepId === "three")?.status, "succeeded");
});

test("rewind applies a prefix-step input override to the re-executed target", async () => {
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

  const steps = await listRunSteps({ runId: first.runId!, ctx: { env } });
  const two = steps.find((step) => step.stepId === "two");
  assert.ok(two);

  // Rewind to `two` (re-executed) and override the preserved prefix step `one`;
  // the edited value flows into the re-executed downstream step.
  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    stepPath: two!.stepPath,
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
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
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
  const steps = await listRunSteps({ runId: first.runId!, ctx: { env } });
  const two = steps.find((step) => step.stepId === "two");

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    stepPath: two!.stepPath,
    inputOverride: { missing: { json: { n: 1 } } },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.ok, false);
  assert.equal((rewind as { error?: { type?: string } }).error?.type, "invalid_input_override");
});

test("rewind rejects an input override for the target step itself", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rewind-targetinput-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
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

  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  const steps = await listRunSteps({ runId: first.runId!, ctx: { env } });
  const two = steps.find((step) => step.stepId === "two");

  // `two` is the re-executed target, so it is not a preserved prefix step and
  // cannot be overridden.
  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    stepPath: two!.stepPath,
    inputOverride: { two: { json: { n: 5 } } },
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

test("rewind rejects a non-step (internal) checkpoint with rewind_target_not_a_step", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rewind-role-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      { steps: [{ id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' }] },
      null,
      2,
    ),
    "utf8",
  );

  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "ok");

  const checkpoints = await listRunCheckpoints({ runId: first.runId!, ctx: { env } });
  const internal = checkpoints.find((checkpoint) => checkpoint.kind === "internal");
  assert.ok(internal, "workflow bookends should be recorded as internal checkpoints");

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    checkpointId: internal!.checkpointId,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.ok, false);
  assert.equal((rewind as { error?: { type?: string } }).error?.type, "rewind_target_not_a_step");
});

test("rewind accepts a stepPath target and resolves it to the step boundary", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-rewind-steppath-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          { id: "one", run: 'node -e "process.stdout.write(JSON.stringify({n:1}))"' },
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

  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const first = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(first.status, "ok");

  const steps = await listRunSteps({ runId: first.runId!, ctx: { env } });
  const one = steps.find((step) => step.stepId === "one");
  assert.ok(one, "the first step should be foldable from its checkpoints");

  const rewind = await rewindToolRequest({
    jobId: first.jobId!,
    stepPath: one!.stepPath,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.status, "ok");
  assert.equal(rewind.jobId, first.jobId);
  assert.notEqual(rewind.runId, first.runId);
  assert.deepEqual(rewind.output, [{ n: 2 }]);

  const rewoundSteps = await listRunSteps({ runId: rewind.runId!, ctx: { env } });
  assert.equal(
    rewoundSteps.find((step) => step.stepId === "one")?.status,
    "succeeded",
    "the targeted step should re-execute in the rewind run",
  );
});
