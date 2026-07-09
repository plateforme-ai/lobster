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
  recordTerminalCancel,
  setJobExternalSession,
  setRunControl,
  writeCacheEntry,
} from "../src/store/runtime_store.js";
import { withRuntimeDb } from "../src/store/sqlite.js";

test("sqlite runtime store persists runs, checkpoints, approvals, and cache entries", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sqlite-store-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

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
    checkpointId: checkpointId!,
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
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  const jobColumns = await withRuntimeDb(
    env,
    (db) => db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>,
  );
  const jobColumnNames = jobColumns.map((row) => row.name);
  assert.ok(jobColumnNames.includes("external_session_key"));
  assert.ok(jobColumnNames.includes("external_provider"));
  assert.ok(jobColumnNames.includes("external_agent_id"));
  assert.ok(jobColumnNames.includes("external_session_id"));

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
    sessionKey: "sess-xyz",
    provider: "openclaw",
    agentId: "main",
    sessionId: "session-uuid-xyz",
  });
  const job = await getJob(env, run.jobId);
  assert.equal(job?.externalProvider, "openclaw");
  assert.equal(job?.externalAgentId, "main");
  assert.equal(job?.externalSessionId, "session-uuid-xyz");
  assert.equal(job?.externalSessionKey, "sess-xyz");
  assert.deepEqual(job?.control, { stepMode: false, desired: "none" });
  const storedRun = await getRun(env, run.runId);
  assert.deepEqual(storedRun?.control, { stepMode: false, desired: "none" });
  const { jobs } = await listJobs({ env });
  assert.equal(jobs.find((entry) => entry.jobId === run.jobId)?.externalSessionKey, "sess-xyz");

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

test("recordTerminalCancel transitions a waiting gate checkpoint and appends a terminal control checkpoint", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-terminal-cancel-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  // Park the run at an approval gate with a pending approval.
  const gateCheckpointId = await appendCheckpoint({
    env,
    run,
    stepId: "gate",
    stepIndex: 1,
    stepType: "approval",
    status: "waiting",
    resumeState: { kind: "workflow-file", resumeAtIndex: 2 },
  });
  await createApprovalRecord({
    env,
    approvalId: "approval-terminal",
    run,
    checkpointId: gateCheckpointId,
    prompt: "Proceed?",
  });
  await setRunControl({ env, runId: run.runId, jobId: run.jobId, desired: "cancel" });
  await withRuntimeDb(env, (db) => {
    db.prepare(`UPDATE runs SET status = 'waiting' WHERE run_id = ?`).run(run.runId);
    db.prepare(`UPDATE jobs SET status = 'waiting' WHERE job_id = ?`).run(run.jobId);
  });

  const terminalId = await recordTerminalCancel({
    env,
    runId: run.runId,
    jobId: run.jobId,
    stepId: "gate",
    stepIndex: 1,
    metadata: { gate: "approval" },
  });
  assert.ok(terminalId);

  const job = await getJob(env, run.jobId);
  assert.equal(job?.status, "cancelled");
  assert.equal(job?.control.desired, "none");

  const checkpoints = await listRunCheckpoints({ env, runId: run.runId });
  const gate = checkpoints.find((cp) => cp.checkpointId === gateCheckpointId);
  assert.equal(gate?.status, "cancelled", "waiting gate checkpoint should be transitioned to cancelled");
  const terminal = checkpoints.find((cp) => cp.checkpointId === terminalId);
  assert.equal(terminal?.stepType, "control");
  assert.equal(terminal?.status, "cancelled");
});

test("setRunControl desired=cancel is observable through getJob/getRun", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cancel-desired-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  await setRunControl({ env, runId: run.runId, jobId: run.jobId, desired: "cancel" });
  assert.equal((await getJob(env, run.jobId))?.control.desired, "cancel");
  assert.equal((await getRun(env, run.runId))?.control.desired, "cancel");
});

test("migration id 5 backfill splits legacy agent-prefixed session ids", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-migration5-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const run = await createRun({ env, sourceType: "workflow_file", workflowFile: "wf.lobster" });

  await withRuntimeDb(env, (db) => {
    db.prepare(
      `UPDATE jobs SET external_session_key = ?, external_agent_id = NULL WHERE job_id = ?`,
    ).run("agent:main:lobster:job_1", run.jobId);
    db.prepare(`
      UPDATE jobs
      SET
        external_agent_id = substr(substr(external_session_key, 7), 1, instr(substr(external_session_key, 7), ':') - 1),
        external_session_key = substr(substr(external_session_key, 7), instr(substr(external_session_key, 7), ':') + 1)
      WHERE external_session_key LIKE 'agent:%'
    `).run();
  });

  const job = await getJob(env, run.jobId);
  assert.equal(job?.externalAgentId, "main");
  assert.equal(job?.externalSessionKey, "lobster:job_1");
});

test("migration id 3 adds agent/model columns and they round-trip through createRun", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-migration3-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

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

test("migration id 4 adds title/description/metadata columns and they round-trip through createRun", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-migration4-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  const run = await createRun({
    env,
    sourceType: "workflow_file",
    workflowFile: "wf.lobster",
    title: " Weekly triage ",
    description: "Review open PRs",
    metadata: { source: "cron", tags: ["triage"] },
  });

  const jobColumns = await withRuntimeDb(
    env,
    (db) => db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>,
  );
  const jobColumnNames = jobColumns.map((row) => row.name);
  assert.ok(jobColumnNames.includes("title"));
  assert.ok(jobColumnNames.includes("description"));
  assert.ok(jobColumnNames.includes("metadata_json"));

  const job = await getJob(env, run.jobId);
  assert.equal(job?.title, "Weekly triage");
  assert.equal(job?.description, "Review open PRs");
  assert.deepEqual(job?.metadata, { source: "cron", tags: ["triage"] });

  const { jobs } = await listJobs({ env });
  const listed = jobs.find((entry) => entry.jobId === run.jobId);
  assert.equal(listed?.title, "Weekly triage");
  assert.equal(listed?.description, "Review open PRs");
  assert.deepEqual(listed?.metadata, { source: "cron", tags: ["triage"] });

  const bare = await createRun({ env, sourceType: "pipeline", pipelineText: "json" });
  const bareJob = await getJob(env, bare.jobId);
  assert.equal(bareJob?.title, null);
  assert.equal(bareJob?.description, null);
  assert.equal(bareJob?.metadata, null);
});

test("migration id 8 surfaces root-run workflow identity on the job payload", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-migration8-"));
  const env = { ...process.env, LOBSTER_DIR: tmpDir };

  const run = await createRun({
    env,
    sourceType: "workflow_file",
    workflowFile: "flows/triage.lobster",
    workflowName: "Weekly triage",
    workflowDescription: "Review and label open issues",
  });

  const runColumns = await withRuntimeDb(
    env,
    (db) => db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>,
  );
  assert.ok(runColumns.map((row) => row.name).includes("workflow_description"));

  const job = await getJob(env, run.jobId);
  assert.equal(job?.workflowFile, "flows/triage.lobster");
  assert.equal(job?.workflowName, "Weekly triage");
  assert.equal(job?.workflowDescription, "Review and label open issues");
  assert.equal(job?.pipelineText, null);

  const { jobs } = await listJobs({ env });
  const listed = jobs.find((entry) => entry.jobId === run.jobId);
  assert.equal(listed?.workflowFile, "flows/triage.lobster");
  assert.equal(listed?.workflowName, "Weekly triage");
  assert.equal(listed?.workflowDescription, "Review and label open issues");

  const pipeline = await createRun({ env, sourceType: "pipeline", pipelineText: "json | echo" });
  const pipelineJob = await getJob(env, pipeline.jobId);
  assert.equal(pipelineJob?.pipelineText, "json | echo");
  assert.equal(pipelineJob?.workflowFile, null);
  assert.equal(pipelineJob?.workflowName, null);
  assert.equal(pipelineJob?.workflowDescription, null);
});

test("large payloads spill to content-addressed blobs and round-trip through the store", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sqlite-blob-"));
  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
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
