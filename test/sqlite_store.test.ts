import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendCheckpoint,
  clearRunControlDesired,
  createApprovalRecord,
  createRun,
  getCheckpoint,
  getCheckpointIO,
  getJob,
  getRun,
  getRunControl,
  listJobRuns,
  listJobCheckpoints,
  listJobs,
  listPendingApprovals,
  listRunCheckpoints,
  readCacheEntry,
  setJobExternalSession,
  setRunControl,
  writeCacheEntry,
} from "../src/store/runtime_store.js";
import { withRuntimeDb } from "../src/store/sqlite.js";

test("sqlite runtime store persists runs, checkpoints, approvals, and cache entries", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sqlite-store-"));
  const env = { ...process.env, LOBSTER_STATE_DIR: tmpDir };

  const run = await createRun({
    env,
    sourceType: "pipeline",
    pipelineText: "json",
    args: { a: 1 },
  });
  const otherRun = await createRun({
    env,
    sourceType: "pipeline",
    pipelineText: "json",
    args: { b: 2 },
  });
  assert.ok(run.jobId);
  assert.equal(run.rootRunId, run.runId);

  const checkpointId = await appendCheckpoint({
    env,
    run,
    stepId: "json",
    stepIndex: 0,
    stepType: "pipeline_stage",
    status: "succeeded",
    io: { jsonOutput: [{ ok: true }] },
  });

  assert.ok(checkpointId);
  const checkpoints = await listRunCheckpoints({ env, runId: run.runId });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].checkpointId, checkpointId);
  assert.equal(checkpoints[0].jobId, run.jobId);
  assert.equal(checkpoints[0].rootRunId, run.rootRunId);
  assert.equal(checkpoints[0].stepPath, "root.json");

  const jobCheckpoints = await listJobCheckpoints({ env, jobId: run.jobId });
  assert.equal(jobCheckpoints.length, 1);

  const tables = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'runs') ORDER BY name",
        )
        .all() as Array<{ name: string }>,
  );
  assert.deepEqual(
    tables.map((row) => row.name),
    ["jobs", "runs"],
  );

  const checkpoint = await getCheckpoint({ env, checkpointId: checkpointId! });
  assert.equal(checkpoint?.status, "succeeded");

  const io = await getCheckpointIO({ env, checkpointId: checkpointId! });
  assert.deepEqual(io?.jsonOutput, [{ ok: true }]);

  await createApprovalRecord({
    env,
    approvalId: "deadbeef",
    run,
    stateKey: "workflow_resume_x",
    prompt: "Proceed?",
  });

  const runs = await listJobRuns({ env, jobId: run.jobId });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, run.runId);
  assert.equal(runs[0].depth, 0);

  const firstJobsPage = await listJobs({ env, status: "running", limit: 1 });
  assert.equal(firstJobsPage.jobs.length, 1);
  assert.ok(firstJobsPage.nextCursor);
  const secondJobsPage = await listJobs({
    env,
    status: "running",
    limit: 1,
    cursor: firstJobsPage.nextCursor,
  });
  assert.equal(secondJobsPage.jobs.length, 1);
  assert.notEqual(secondJobsPage.jobs[0].jobId, firstJobsPage.jobs[0].jobId);
  assert.ok([run.jobId, otherRun.jobId].includes(firstJobsPage.jobs[0].jobId));
  assert.ok([run.jobId, otherRun.jobId].includes(secondJobsPage.jobs[0].jobId));

  const pendingApprovals = await listPendingApprovals({ env });
  assert.equal(pendingApprovals.approvals.length, 1);
  assert.equal(pendingApprovals.approvals[0].approvalId, "deadbeef");
  assert.equal(pendingApprovals.approvals[0].prompt, "Proceed?");

  await writeCacheEntry({
    env,
    entry: {
      namespace: "test",
      cacheKey: "k1",
      input: { prompt: "hello" },
      items: [{ answer: 42 }],
    },
  });
  const cache = await readCacheEntry({ env, namespace: "test", cacheKey: "k1" });
  assert.deepEqual(cache?.items, [{ answer: 42 }]);
  assert.equal(cache?.hitCount, 1);
});

test("migration id 2 adds session columns and the run_controls table", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-migration2-"));
  const env = { ...process.env, LOBSTER_STATE_DIR: tmpDir };

  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  const jobColumns = await withRuntimeDb(
    env,
    (db) => db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>,
  );
  const jobColumnNames = jobColumns.map((row) => row.name);
  assert.ok(jobColumnNames.includes("external_session_id"));
  assert.ok(jobColumnNames.includes("external_session_provider"));

  const controlTable = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_controls'")
        .get() as { name: string } | undefined,
  );
  assert.equal(controlTable?.name, "run_controls");

  // setJobExternalSession round-trips through getJob/listJobs.
  await setJobExternalSession({
    env,
    jobId: run.jobId,
    sessionId: "sess-xyz",
    provider: "openclaw",
  });
  const job = await getJob(env, run.jobId);
  assert.equal(job?.externalSessionId, "sess-xyz");
  assert.equal(job?.externalSessionProvider, "openclaw");
  assert.deepEqual(job?.control, { stepMode: false, desired: "none" });
  const storedRun = await getRun(env, run.runId);
  assert.deepEqual(storedRun?.control, { stepMode: false, desired: "none" });
  const { jobs } = await listJobs({ env });
  assert.equal(jobs.find((entry) => entry.jobId === run.jobId)?.externalSessionId, "sess-xyz");

  // run control upsert + clear semantics.
  await setRunControl({ env, runId: run.runId, jobId: run.jobId, stepMode: true });
  let control = await getRunControl({ env, runId: run.runId });
  assert.equal(control?.stepMode, true);
  assert.equal(control?.desired, "none");
  assert.equal((await getJob(env, run.jobId))?.control.stepMode, true);
  assert.equal((await getJob(env, run.jobId))?.control.desired, "none");
  assert.equal((await getRun(env, run.runId))?.control.stepMode, true);
  assert.equal((await getRun(env, run.runId))?.control.desired, "none");

  await setRunControl({ env, runId: run.runId, jobId: run.jobId, desired: "pause" });
  control = await getRunControl({ env, runId: run.runId });
  assert.equal(control?.desired, "pause");
  assert.equal(control?.stepMode, true, "stepMode should persist across desired updates");
  assert.equal((await getJob(env, run.jobId))?.control.desired, "pause");
  assert.equal((await getJob(env, run.jobId))?.control.stepMode, true);
  assert.equal((await getRun(env, run.runId))?.control.desired, "pause");
  assert.equal((await getRun(env, run.runId))?.control.stepMode, true);

  await clearRunControlDesired({ env, runId: run.runId });
  control = await getRunControl({ env, runId: run.runId });
  assert.equal(control?.desired, "none");
  assert.equal(control?.stepMode, true);
});

test("migration id 3 adds agent/model columns and they round-trip through createRun", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-migration3-"));
  const env = { ...process.env, LOBSTER_STATE_DIR: tmpDir };

  const run = await createRun({
    env,
    sourceType: "workflow_file",
    workflowFile: "wf.lobster",
    agent: "researcher",
    model: "gpt-5",
  });

  const jobColumns = await withRuntimeDb(
    env,
    (db) => db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>,
  );
  const jobColumnNames = jobColumns.map((row) => row.name);
  assert.ok(jobColumnNames.includes("agent"));
  assert.ok(jobColumnNames.includes("model"));

  const job = await getJob(env, run.jobId);
  assert.equal(job?.agent, "researcher");
  assert.equal(job?.model, "gpt-5");

  const { jobs } = await listJobs({ env });
  const listed = jobs.find((entry) => entry.jobId === run.jobId);
  assert.equal(listed?.agent, "researcher");
  assert.equal(listed?.model, "gpt-5");

  // agent/model are optional and default to null.
  const bare = await createRun({ env, sourceType: "pipeline", pipelineText: "json" });
  const bareJob = await getJob(env, bare.jobId);
  assert.equal(bareJob?.agent, null);
  assert.equal(bareJob?.model, null);
});

test("large payloads spill to content-addressed blobs and round-trip through the store", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sqlite-blob-"));
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: tmpDir,
    // Force everything above a tiny threshold onto disk as a blob.
    LOBSTER_CHECKPOINT_INLINE_MAX_BYTES: "64",
    LOBSTER_CACHE_INLINE_MAX_BYTES: "64",
  };

  const bigText = "x".repeat(4096);

  const run = await createRun({ env, sourceType: "pipeline", pipelineText: "json" });
  const checkpointId = await appendCheckpoint({
    env,
    run,
    stepId: "json",
    stepIndex: 0,
    stepType: "pipeline_stage",
    status: "succeeded",
    io: { stdout: bigText, jsonOutput: [{ big: bigText }] },
  });
  assert.ok(checkpointId);

  // The blob lives on disk, not inline in the row.
  const ioRow = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare(
          "SELECT stdout_blob_id, json_output_blob_id FROM checkpoint_io WHERE checkpoint_id = ?",
        )
        .get(checkpointId!) as {
        stdout_blob_id: string | null;
        json_output_blob_id: string | null;
      },
  );
  assert.ok(ioRow.stdout_blob_id, "expected stdout to spill to a blob");
  assert.ok(ioRow.json_output_blob_id, "expected jsonOutput to spill to a blob");

  const io = await getCheckpointIO({ env, checkpointId: checkpointId! });
  assert.equal(io?.stdout, bigText);
  assert.deepEqual(io?.jsonOutput, [{ big: bigText }]);

  await writeCacheEntry({
    env,
    entry: { namespace: "blobs", cacheKey: "big", items: [{ big: bigText }] },
  });
  const cacheRow = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare(
          "SELECT output_blob_id, output_inline_json FROM cache_entries WHERE namespace = ? AND cache_key = ?",
        )
        .get("blobs", "big") as {
        output_blob_id: string | null;
        output_inline_json: string | null;
      },
  );
  assert.ok(cacheRow.output_blob_id, "expected cache output to spill to a blob");
  assert.equal(cacheRow.output_inline_json, null);

  const cached = await readCacheEntry({ env, namespace: "blobs", cacheKey: "big" });
  assert.deepEqual(cached?.items, [{ big: bigText }]);
});
