import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listRunCheckpoints,
  rerunToolRequest,
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
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_CHECKPOINTS_ENABLED: "true",
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
  assert.notEqual(rewind.jobId, first.jobId);
  assert.deepEqual(rewind.output, [{ n: 2 }]);
});
