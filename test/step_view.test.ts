import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendCheckpoint,
  cancelSupersededRuns,
  createRun,
  createRewindRun,
  foldCheckpointsIntoSteps,
  getJob,
  getRun,
  listJobStepsAllRuns,
  listRunCheckpoints,
  listRunSteps,
} from "../src/store/runtime_store.js";
import { withRuntimeDb } from "../src/store/sqlite.js";
import type { CheckpointRecord } from "../src/workflows/checkpoints.js";

function cp(
  partial: Partial<CheckpointRecord> &
    Pick<CheckpointRecord, "checkpointId" | "seq" | "kind" | "name" | "status">,
): CheckpointRecord {
  return {
    jobId: "job_1",
    runId: "run_1",
    rootRunId: "run_1",
    stepId: partial.stepPath ?? null,
    stepPath: null,
    stepIndex: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-07-06T00:00:00Z",
    ...partial,
  };
}

test("foldCheckpointsIntoSteps groups checkpoints per step and hides internal rows", () => {
  const checkpoints: CheckpointRecord[] = [
    cp({ checkpointId: "wf_start", seq: 1, kind: "internal", name: "start", status: "started" }),
    cp({
      checkpointId: "gate_build",
      seq: 2,
      kind: "gate",
      name: "approval",
      status: "waiting",
      stepPath: "root.build",
      stepId: "build",
      stepIndex: 0,
    }),
    cp({
      checkpointId: "meta_build",
      seq: 3,
      kind: "detail",
      name: "metadata",
      status: "succeeded",
      stepPath: "root.build",
      stepId: "build",
      stepIndex: 0,
    }),
    cp({
      checkpointId: "done_build",
      seq: 4,
      kind: "step",
      name: "shell",
      status: "succeeded",
      stepPath: "root.build",
      stepId: "build",
      stepIndex: 0,
    }),
    cp({
      checkpointId: "done_deploy",
      seq: 5,
      kind: "step",
      name: "shell",
      status: "failed",
      stepPath: "root.deploy",
      stepId: "deploy",
      stepIndex: 1,
    }),
    cp({ checkpointId: "wf_end", seq: 6, kind: "internal", name: "end", status: "succeeded" }),
  ];

  const steps = foldCheckpointsIntoSteps(checkpoints);
  assert.equal(steps.length, 2, "internal bookends must not become steps");

  const build = steps[0];
  assert.equal(build.stepPath, "root.build");
  assert.equal(build.name, "shell", "StepRecord.name is the boundary step's exec kind");
  assert.equal(build.status, "succeeded", "terminal outcome wins over the earlier waiting gate");
  assert.equal(build.gate, null, "resolved step drops its gate once it terminates");
  assert.equal(build.boundaryCheckpointId, "done_build");
  assert.deepEqual(build.detailCheckpointIds, ["meta_build"], "detail rows attach to their step");

  const deploy = steps[1];
  assert.equal(deploy.stepPath, "root.deploy");
  assert.equal(deploy.status, "failed");
  assert.deepEqual(deploy.detailCheckpointIds, []);
});

test("foldCheckpointsIntoSteps surfaces an active waiting gate as the step boundary", () => {
  const steps = foldCheckpointsIntoSteps([
    cp({
      checkpointId: "gate",
      seq: 1,
      kind: "gate",
      name: "input",
      status: "waiting",
      stepPath: "root.ask",
      stepId: "ask",
    }),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "waiting");
  assert.deepEqual(steps[0].gate, { checkpointId: "gate", name: "input" });
  assert.equal(steps[0].boundaryCheckpointId, "gate");
});

test("foldCheckpointsIntoSteps folds an llm-invoke step's stages into a single StepRecord", () => {
  // All of a step's checkpoints share the SAME owning step_path/step_id/step_index;
  // the sub-operations differ only in `name`. Grouping is a pure GROUP BY step_path.
  const owner = { stepPath: "root.draft", stepId: "draft", stepIndex: 2 };
  const steps = foldCheckpointsIntoSteps([
    cp({ checkpointId: "start", seq: 1, kind: "internal", name: "start", status: "started" }),
    cp({
      checkpointId: "stage_a",
      seq: 2,
      kind: "detail",
      name: "llm.invoke",
      status: "started",
      ...owner,
    }),
    cp({
      checkpointId: "stage_b",
      seq: 3,
      kind: "detail",
      name: "json",
      status: "succeeded",
      ...owner,
    }),
    cp({
      checkpointId: "out",
      seq: 4,
      kind: "internal",
      name: "output",
      status: "succeeded",
      ...owner,
    }),
    cp({
      checkpointId: "done",
      seq: 5,
      kind: "step",
      name: "pipeline",
      status: "succeeded",
      ...owner,
    }),
  ]);
  assert.equal(steps.length, 1, "a pipeline step yields exactly one StepRecord");
  const step = steps[0];
  assert.equal(step.stepPath, "root.draft");
  assert.equal(step.stepId, "draft");
  assert.equal(step.stepIndex, 2);
  assert.equal(step.name, "pipeline");
  assert.equal(step.status, "succeeded");
  assert.deepEqual(
    step.detailCheckpointIds,
    ["stage_a", "stage_b"],
    "only detail rows attach; internal output/bookend are hidden",
  );
});

test("listRunSteps persists kind/name and folds durable checkpoints into steps", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-step-view-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  await appendCheckpoint({
    env,
    run,
    stepId: "one",
    stepIndex: 0,
    stepPath: "root.one",
    kind: "step",
    name: "shell",
    status: "succeeded",
  });
  await appendCheckpoint({
    env,
    run,
    stepId: "one",
    stepIndex: 0,
    stepPath: "root.one",
    kind: "detail",
    name: "metadata",
    status: "succeeded",
  });
  await appendCheckpoint({
    env,
    run,
    stepId: "two",
    stepIndex: 1,
    stepPath: "root.two",
    kind: "gate",
    name: "approval",
    status: "waiting",
  });

  const rawCheckpoints = await listRunCheckpoints({ env, runId: run.runId });
  const kinds = new Set(rawCheckpoints.map((c) => c.kind));
  assert.ok(
    kinds.has("step") && kinds.has("detail") && kinds.has("gate"),
    "kind round-trips through the store",
  );
  const names = new Set(rawCheckpoints.map((c) => c.name));
  assert.ok(
    names.has("shell") && names.has("metadata") && names.has("approval"),
    "name round-trips through the store",
  );

  const steps = await listRunSteps({ env, runId: run.runId });
  assert.equal(steps.length, 2, "detail row folds into its step rather than becoming its own");
  assert.equal(steps[0].stepId, "one");
  assert.equal(steps[0].name, "shell");
  assert.equal(steps[0].status, "succeeded");
  assert.equal(steps[0].detailCheckpointIds.length, 1);
  assert.equal(steps[1].stepId, "two");
  assert.equal(steps[1].status, "waiting");
  assert.ok(steps[1].gate, "unresolved gate exposes its blocker");
  assert.equal(steps[1].gate?.name, "approval");
});

test("listJobStepsAllRuns folds each run independently so same-path steps never collide", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-all-runs-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  // Origin run: two completed steps.
  const origin = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });
  await appendCheckpoint({
    env,
    run: origin,
    stepId: "one",
    stepIndex: 0,
    stepPath: "root.one",
    kind: "step",
    name: "shell",
    status: "succeeded",
  });
  const originTwoId = await appendCheckpoint({
    env,
    run: origin,
    stepId: "two",
    stepIndex: 1,
    stepPath: "root.two",
    kind: "step",
    name: "shell",
    status: "succeeded",
  });

  // Rewind at step two: a new run replays the target step onward (two, three).
  // `root.two` now exists in BOTH runs.
  const job = await getJob(env, origin.jobId);
  const targetRun = await getRun(env, origin.runId);
  assert.ok(job && targetRun, "origin job/run exist");
  const rewind = await createRewindRun({
    env,
    job: job!,
    targetRun: targetRun!,
    checkpointId: originTwoId,
  });
  const rewindTwoId = await appendCheckpoint({
    env,
    run: rewind,
    stepId: "two",
    stepIndex: 1,
    stepPath: "root.two",
    kind: "step",
    name: "shell",
    status: "succeeded",
  });
  await appendCheckpoint({
    env,
    run: rewind,
    stepId: "three",
    stepIndex: 2,
    stepPath: "root.three",
    kind: "step",
    name: "shell",
    status: "succeeded",
  });

  const steps = await listJobStepsAllRuns({ env, jobId: origin.jobId });
  assert.equal(steps.length, 4, "a flat job-wide fold would collide the two root.two steps into 3");

  // Runs are ordered oldest-first: origin (one, two) then rewind (two, three).
  assert.deepEqual(
    steps.map((s) => s.stepPath),
    ["root.one", "root.two", "root.two", "root.three"],
  );
  assert.deepEqual(
    steps.map((s) => s.runId),
    [origin.runId, origin.runId, rewind.runId, rewind.runId],
  );

  const twos = steps.filter((s) => s.stepPath === "root.two");
  assert.equal(twos.length, 2, "the same step path survives once per run");
  assert.notEqual(
    twos[0].boundaryCheckpointId,
    twos[1].boundaryCheckpointId,
    "each run's root.two keeps its own boundary checkpoint",
  );
  assert.equal(twos[0].boundaryCheckpointId, originTwoId);
  assert.equal(twos[1].boundaryCheckpointId, rewindTwoId);
});

test("cancelSupersededRuns marks in-flight runs superseded and clears their gates", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-superseded-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  const doneId = await appendCheckpoint({
    env,
    run,
    stepId: "one",
    stepIndex: 0,
    stepPath: "root.one",
    kind: "step",
    name: "shell",
    status: "succeeded",
  });
  const gateId = await appendCheckpoint({
    env,
    run,
    stepId: "two",
    stepIndex: 1,
    stepPath: "root.two",
    kind: "gate",
    name: "approval",
    status: "waiting",
  });
  await withRuntimeDb(env, (db) => {
    db.prepare(`UPDATE runs SET status = 'waiting' WHERE run_id = ?`).run(run.runId);
    db.prepare(`UPDATE jobs SET status = 'waiting' WHERE job_id = ?`).run(run.jobId);
  });

  await cancelSupersededRuns({ env, jobId: run.jobId });

  const stored = await getRun(env, run.runId);
  assert.equal(stored?.status, "superseded", "rewound-over run is superseded, not cancelled");

  const checkpoints = await listRunCheckpoints({ env, runId: run.runId });
  const gate = checkpoints.find((c) => c.checkpointId === gateId);
  const done = checkpoints.find((c) => c.checkpointId === doneId);
  assert.equal(
    gate?.status,
    "cancelled",
    "open gate is cleared so no zombie waiting gate survives",
  );
  assert.equal(done?.status, "succeeded", "completed step checkpoints remain intact and queryable");
});
