import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getCheckpointIO,
  listJobCheckpoints,
  listRunCheckpoints,
  rewindToolRequest,
  runToolRequest,
} from "../src/core/index.js";

test("workflow tool runs create sqlite checkpoints and redact secret-looking output", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-checkpoints-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "secret",
            run: "node -e \"process.stdout.write('Bearer sk_test_123456789abcdef')\"",
          },
          {
            id: "done",
            run: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
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
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const result = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.ok(result.jobId);
  assert.ok(result.runId);

  const checkpoints = await listRunCheckpoints({ runId: result.runId!, ctx: { env } });
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stepId === "secret"));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stepId === "workflow_output"));

  const secretCheckpoint = checkpoints.find((checkpoint) => checkpoint.stepId === "secret");
  assert.ok(secretCheckpoint);
  const io = await getCheckpointIO({ checkpointId: secretCheckpoint!.checkpointId, ctx: { env } });
  assert.equal(io?.stdout, "[REDACTED]");
});

test("nested workflow checkpoints share jobId and use child runId with stable stepPath", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-checkpoints-"));
  const childPath = path.join(tmpDir, "child.lobster");
  const parentPath = path.join(tmpDir, "parent.lobster");
  await fsp.writeFile(
    childPath,
    JSON.stringify(
      {
        steps: [
          { id: "childStep", run: 'node -e "process.stdout.write(JSON.stringify({child:true}))"' },
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
        steps: [{ id: "sub", workflow: "child.lobster" }],
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

  const result = await runToolRequest({ filePath: parentPath, ctx: { cwd: tmpDir, env } });
  assert.equal(result.status, "ok");
  assert.ok(result.jobId);
  assert.ok(result.runId);

  const jobCheckpoints = await listJobCheckpoints({ jobId: result.jobId!, ctx: { env } });
  const childCheckpoint = jobCheckpoints.find((checkpoint) => checkpoint.stepId === "childStep");
  assert.ok(childCheckpoint);
  assert.equal(childCheckpoint!.jobId, result.jobId);
  assert.notEqual(childCheckpoint!.runId, result.runId);
  assert.equal(childCheckpoint!.rootRunId, result.rootRunId);
  assert.equal(childCheckpoint!.parentRunId, result.runId);
  assert.equal(childCheckpoint!.stepPath, "root.sub.childStep");

  const rootCheckpoints = await listRunCheckpoints({ runId: result.runId!, ctx: { env } });
  assert.equal(
    rootCheckpoints.some((checkpoint) => checkpoint.stepId === "childStep"),
    false,
  );

  const rewind = await rewindToolRequest({
    jobId: result.jobId!,
    checkpointId: childCheckpoint!.checkpointId,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rewind.status, "ok");
  assert.notEqual(rewind.jobId, result.jobId);
  assert.deepEqual(rewind.output, [{ child: true }]);
});

test("workflow pipeline checkpoints are scoped under the owning step path", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-pipeline-checkpoints-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "source",
            run: 'node -e "process.stdout.write(JSON.stringify({ticket:1}))"',
          },
          {
            id: "transform",
            pipeline: "json",
            stdin: "$source.json",
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
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const result = await runToolRequest({ filePath, ctx: { cwd: tmpDir, env } });
  assert.equal(result.status, "ok");
  assert.ok(result.runId);

  const checkpoints = await listRunCheckpoints({ runId: result.runId, ctx: { env } });
  assert.ok(
    checkpoints.some(
      (checkpoint) =>
        checkpoint.stepId === "transform" &&
        checkpoint.stepPath === "root.transform" &&
        checkpoint.stepType === "pipeline",
    ),
  );
  assert.ok(
    checkpoints.some(
      (checkpoint) =>
        checkpoint.stepId === "json" &&
        checkpoint.stepPath === "root.transform.json" &&
        checkpoint.stepType === "pipeline_stage",
    ),
  );
  assert.ok(
    checkpoints.some(
      (checkpoint) =>
        checkpoint.stepId === "pipeline_output" &&
        checkpoint.stepPath === "root.transform.pipeline_output" &&
        checkpoint.stepType === "pipeline_result",
    ),
  );
  assert.equal(
    checkpoints.some((checkpoint) => checkpoint.stepPath === "root.json"),
    false,
  );
});

test("standalone pipeline checkpoints keep top-level step paths", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-standalone-pipeline-"));
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
  };

  const result = await runToolRequest({ pipeline: "json", ctx: { cwd: tmpDir, env } });
  assert.equal(result.status, "ok");
  assert.ok(result.runId);

  const checkpoints = await listRunCheckpoints({ runId: result.runId, ctx: { env } });
  assert.ok(
    checkpoints.some(
      (checkpoint) =>
        checkpoint.stepId === "json" &&
        checkpoint.stepPath === "root.json" &&
        checkpoint.stepType === "pipeline_stage",
    ),
  );
  assert.ok(
    checkpoints.some(
      (checkpoint) =>
        checkpoint.stepId === "pipeline_output" &&
        checkpoint.stepPath === "root.pipeline_output" &&
        checkpoint.stepType === "pipeline_result",
    ),
  );
});
