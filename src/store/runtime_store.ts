import { randomUUID } from "node:crypto";

import type {
  ApprovalRecord,
  BlobRecord,
  CacheEntry,
  CacheEntryRecord,
  CheckpointIORecord,
  CheckpointRecord,
  JobRecord,
  JobWaitKind,
  JobWaitSnapshot,
  RunControlRecord,
  RunControlSnapshot,
  RunControlState,
  WorkflowExecutionContext,
  RunRecord,
  RunStatus,
} from "../workflows/checkpoints.js";
import { storePayload, readBlobJson } from "./blob_store.js";
import { parseJsonSafe, stringifySafe } from "./serialization.js";
import { withRuntimeDb } from "./sqlite.js";

type WaitGateStepType = (typeof WAIT_GATE_STEP_TYPES)[number];

const DEFAULT_CHECKPOINT_INLINE_BYTES = 65_536;
const DEFAULT_CHECKPOINT_PREVIEW_BYTES = 16_384;
const DEFAULT_CACHE_INLINE_BYTES = 65_536;
const DEFAULT_CACHE_TTL_DAYS = 30;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const WAIT_GATE_STEP_TYPES = ["pause", "approval", "input", "pipeline_input"] as const;
const WAIT_GATE_STEP_TYPE_SQL = WAIT_GATE_STEP_TYPES.map(() => "?").join(", ");

export function checkpointsEnabled(env: Record<string, string | undefined>) {
  return String(env.LOBSTER_CHECKPOINTS_ENABLED ?? "").toLowerCase() === "true";
}

export function createCheckpointRun(
  runId: string,
  options?: Partial<WorkflowExecutionContext>,
): WorkflowExecutionContext {
  return {
    jobId: options?.jobId ?? runId,
    runId,
    rootRunId: options?.rootRunId ?? runId,
    parentRunId: options?.parentRunId ?? null,
    parentStepId: options?.parentStepId ?? null,
    parentStepPath: options?.parentStepPath ?? null,
    stepPathPrefix: options?.stepPathPrefix ?? "root",
    depth: options?.depth ?? 0,
    latestCheckpointId: options?.latestCheckpointId ?? null,
  };
}

export async function createRun(params: {
  env: Record<string, string | undefined>;
  sourceType: "workflow_file" | "pipeline";
  workflowFile?: string | null;
  workflowName?: string | null;
  pipelineText?: string | null;
  workflowDescription?: string | null;
  args?: unknown;
  agent?: string | null;
  model?: string | null;
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  parentJobId?: string | null;
  rootJobId?: string | null;
}) {
  const now = new Date().toISOString();
  const jobId = randomUUID();
  const runId = randomUUID();
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `INSERT INTO jobs (
        job_id, root_run_id, status, source_type, parent_job_id, root_job_id,
        latest_run_id, agent, model, title, description, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      runId,
      "running",
      params.sourceType,
      params.parentJobId ?? null,
      params.rootJobId ?? jobId,
      runId,
      params.agent ?? null,
      params.model ?? null,
      normalizeStoredJobText(params.title),
      normalizeStoredJobText(params.description),
      params.metadata === undefined || params.metadata === null
        ? null
        : stringifySafe(params.metadata),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO runs (
        run_id, job_id, root_run_id, parent_run_id, parent_step_id, parent_step_path,
        status, source_type, workflow_file, workflow_name, pipeline_text, workflow_description,
        args_json, latest_checkpoint_id, depth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      jobId,
      runId,
      null,
      null,
      null,
      "running",
      params.sourceType,
      params.workflowFile ?? null,
      params.workflowName ?? null,
      params.pipelineText ?? null,
      params.workflowDescription ?? null,
      params.args === undefined ? null : stringifySafe(params.args),
      null,
      0,
      now,
      now,
    );
  });
  return createCheckpointRun(runId, { jobId, rootRunId: runId, stepPathPrefix: "root" });
}

/**
 * Insert a new top-level run under an existing job (rewind). The run shares the
 * job's original `root_run_id` (so job-wide control anchored on the root run is
 * inherited) but has a fresh `run_id`, `parent_run_id = null`, and records the
 * checkpoint it rewound from. Moves `jobs.latest_run_id` to the new run so the
 * job mirrors this attempt going forward. No new job row is created.
 */
export async function createRewindRun(params: {
  env: Record<string, string | undefined>;
  job: JobRecord;
  targetRun: RunRecord;
  checkpointId: string;
  args?: unknown;
}): Promise<WorkflowExecutionContext> {
  const now = new Date().toISOString();
  const runId = randomUUID();
  const jobId = params.job.jobId;
  const rootRunId = params.job.rootRunId ?? runId;
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `INSERT INTO runs (
        run_id, job_id, root_run_id, parent_run_id, parent_step_id, parent_step_path,
        rewind_of_checkpoint_id, status, source_type, workflow_file, workflow_name,
        pipeline_text, workflow_description, args_json, latest_checkpoint_id, depth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      jobId,
      rootRunId,
      null,
      null,
      null,
      params.checkpointId,
      "running",
      params.targetRun.sourceType,
      params.targetRun.workflowFile ?? null,
      params.targetRun.workflowName ?? null,
      params.targetRun.pipelineText ?? null,
      params.targetRun.workflowDescription ?? null,
      params.args === undefined ? null : stringifySafe(params.args),
      null,
      0,
      now,
      now,
    );
    db.prepare(
      `UPDATE jobs SET latest_run_id = ?, status = 'running', updated_at = ? WHERE job_id = ?`,
    ).run(runId, now, jobId);
  });
  return createCheckpointRun(runId, { jobId, rootRunId, stepPathPrefix: "root" });
}

/**
 * Cancel every run of a job that is still `running`/`waiting` (except
 * `exceptRunId`) and flip their still-`waiting` gate checkpoints/approvals to a
 * terminal state so no zombie waiting gates survive a rewind replay.
 */
export async function cancelSupersededRuns(params: {
  env: Record<string, string | undefined>;
  jobId: string;
  exceptRunId?: string | null;
}) {
  const now = new Date().toISOString();
  const except = params.exceptRunId ?? null;
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `UPDATE runs SET status = 'cancelled', updated_at = ?
        WHERE job_id = ? AND status IN ('running', 'waiting')
        AND (? IS NULL OR run_id != ?)`,
    ).run(now, params.jobId, except, except);
    db.prepare(
      `UPDATE checkpoints SET status = 'cancelled', finished_at = ?
        WHERE job_id = ? AND status = 'waiting'
        AND step_type IN (${WAIT_GATE_STEP_TYPE_SQL})
        AND (? IS NULL OR run_id != ?)`,
    ).run(now, params.jobId, ...WAIT_GATE_STEP_TYPES, except, except);
    db.prepare(
      `UPDATE approvals SET status = 'cancelled', decision = 'superseded', resolved_at = ?
        WHERE job_id = ? AND status = 'waiting'
        AND (? IS NULL OR run_id != ?)`,
    ).run(now, params.jobId, except, except);
  });
}

/**
 * Clear a stale `cancel`/`pause` intent on the job's root run control row before
 * a rewind replay. Control is job-wide and physically stored on the root run, so
 * a replay would otherwise inherit the prior attempt's desired transition.
 */
export async function resetJobControlDesired(params: {
  env: Record<string, string | undefined>;
  jobId: string;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    const job = db.prepare("SELECT root_run_id FROM jobs WHERE job_id = ?").get(params.jobId) as
      | { root_run_id?: string | null }
      | undefined;
    if (!job?.root_run_id) return;
    db.prepare("UPDATE run_controls SET desired = 'none', updated_at = ? WHERE run_id = ?").run(
      now,
      job.root_run_id,
    );
  });
}

/**
 * Update job labeling fields. Only provided fields are written; `metadata` is
 * shallow-merged over the job's current metadata.
 */
export async function updateJobMetadata(params: {
  env: Record<string, string | undefined>;
  jobId: string;
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    const row = db.prepare("SELECT metadata_json FROM jobs WHERE job_id = ?").get(params.jobId) as
      | { metadata_json?: string | null }
      | undefined;
    if (!row) return;
    const sets: string[] = [];
    const values: string[] = [];
    if (params.title !== undefined) {
      sets.push("title = ?");
      values.push(normalizeStoredJobText(params.title));
    }
    if (params.description !== undefined) {
      sets.push("description = ?");
      values.push(normalizeStoredJobText(params.description));
    }
    if (params.metadata !== undefined) {
      const current =
        row.metadata_json === null || row.metadata_json === undefined
          ? null
          : (parseJsonSafe(row.metadata_json) as Record<string, unknown> | null);
      const merged = params.metadata === null ? null : { ...current, ...params.metadata };
      sets.push("metadata_json = ?");
      values.push(merged === null ? null : stringifySafe(merged));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    values.push(now);
    values.push(params.jobId);
    db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...values);
  });
}

export async function createChildRun(params: {
  env: Record<string, string | undefined>;
  parent: WorkflowExecutionContext;
  parentStepId: string;
  parentStepPath: string;
  workflowFile: string;
  workflowName?: string | null;
  workflowDescription?: string | null;
  args?: unknown;
}) {
  const now = new Date().toISOString();
  const runId = randomUUID();
  const stepPathPrefix = params.parentStepPath;
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `INSERT INTO runs (
        run_id, job_id, root_run_id, parent_run_id, parent_step_id, parent_step_path,
        status, source_type, workflow_file, workflow_name, workflow_description, args_json,
        latest_checkpoint_id, depth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      params.parent.jobId,
      params.parent.rootRunId,
      params.parent.runId,
      params.parentStepId,
      params.parentStepPath,
      "running",
      "workflow_file",
      params.workflowFile,
      params.workflowName ?? null,
      params.workflowDescription ?? null,
      params.args === undefined ? null : stringifySafe(params.args),
      null,
      params.parent.depth + 1,
      now,
      now,
    );
  });
  return createCheckpointRun(runId, {
    jobId: params.parent.jobId,
    rootRunId: params.parent.rootRunId,
    parentRunId: params.parent.runId,
    parentStepId: params.parentStepId,
    parentStepPath: params.parentStepPath,
    stepPathPrefix,
    depth: params.parent.depth + 1,
  });
}

export async function updateRun(params: {
  env: Record<string, string | undefined>;
  runId: string;
  status?: RunStatus;
  latestCheckpointId?: string | null;
  finalOutput?: unknown;
}) {
  const now = new Date().toISOString();
  const finalPayload =
    params.finalOutput === undefined
      ? null
      : await storePayload({
          env: params.env,
          value: params.finalOutput,
          inlineMaxBytes: resolveCheckpointInlineBytes(params.env),
          previewBytes: resolveCheckpointPreviewBytes(params.env),
        });
  const current = (await getRun(params.env, params.runId)) as RunRecord | null;
  if (finalPayload?.blob) await upsertBlob(params.env, finalPayload.blob);
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `UPDATE runs
      SET status = ?, latest_checkpoint_id = ?, updated_at = ?
      WHERE run_id = ?`,
    ).run(
      params.status ?? current?.status ?? "running",
      params.latestCheckpointId ?? current?.latestCheckpointId ?? null,
      now,
      params.runId,
    );
    const jobRow = current
      ? (db.prepare("SELECT latest_run_id FROM jobs WHERE job_id = ?").get(current.jobId) as
          | { latest_run_id?: string | null }
          | undefined)
      : undefined;
    if (current && jobRow?.latest_run_id === params.runId) {
      db.prepare(
        `UPDATE jobs
        SET status = ?, latest_checkpoint_id = ?, final_output_json = ?,
          final_output_blob_id = ?, updated_at = ?
        WHERE job_id = ?`,
      ).run(
        params.status ?? current?.status ?? "running",
        params.latestCheckpointId ?? current?.latestCheckpointId ?? null,
        finalPayload
          ? finalPayload.inlineJson
          : current?.finalOutput
            ? stringifySafe(current.finalOutput)
            : null,
        finalPayload ? finalPayload.blobId : (current?.finalOutputBlobId ?? null),
        now,
        current.jobId,
      );
    }
  });
}

export async function getRun(
  env: Record<string, string | undefined>,
  runId: string,
): Promise<RunRecord | null> {
  const row = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare(
          `SELECT runs.*, jobs.final_output_json, jobs.final_output_blob_id,
            rc.desired AS control_desired,
            rc.step_mode AS control_step_mode,
            rc.updated_at AS control_updated_at
          FROM runs
          JOIN jobs ON jobs.job_id = runs.job_id
          LEFT JOIN run_controls rc ON rc.run_id = runs.root_run_id
          WHERE runs.run_id = ?`,
        )
        .get(runId) as any,
  );
  if (!row) return null;
  return rowToRun(env, row);
}

export async function getJob(
  env: Record<string, string | undefined>,
  jobId: string,
): Promise<JobRecord | null> {
  const row = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare(
          `SELECT jobs.*,
            root_run.workflow_file AS root_workflow_file,
            root_run.workflow_name AS root_workflow_name,
            root_run.pipeline_text AS root_pipeline_text,
            root_run.workflow_description AS root_workflow_description,
            rc.desired AS control_desired,
            rc.step_mode AS control_step_mode,
            rc.updated_at AS control_updated_at
          FROM jobs
          LEFT JOIN runs AS root_run ON root_run.run_id = jobs.root_run_id
          LEFT JOIN run_controls rc ON rc.run_id = jobs.root_run_id
          WHERE jobs.job_id = ?`,
        )
        .get(jobId) as any,
  );
  if (!row) return null;
  const job = await rowToJob(env, row);
  job.wait = await resolveJobHeadWait({ env, jobId });
  return job;
}

export async function setJobExternalSession(params: {
  env: Record<string, string | undefined>;
  jobId: string;
  sessionKey: string | null;
  provider?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `UPDATE jobs SET external_session_key = ?, external_provider = ?, external_agent_id = ?, external_session_id = ?, updated_at = ? WHERE job_id = ?`,
    ).run(
      params.sessionKey ?? null,
      params.provider ?? null,
      params.agentId ?? null,
      params.sessionId ?? null,
      now,
      params.jobId,
    );
  });
}

export async function getRunControl(params: {
  env: Record<string, string | undefined>;
  runId: string;
}): Promise<RunControlRecord | null> {
  const row = await withRuntimeDb(
    params.env,
    (db) => db.prepare("SELECT * FROM run_controls WHERE run_id = ?").get(params.runId) as any,
  );
  if (!row) return null;
  return {
    runId: row.run_id,
    jobId: row.job_id,
    desired: (row.desired as RunControlState) ?? "none",
    stepMode: Boolean(row.step_mode),
    updatedAt: row.updated_at,
  };
}

export async function setRunControl(params: {
  env: Record<string, string | undefined>;
  runId: string;
  jobId: string;
  desired?: RunControlState;
  stepMode?: boolean;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    const existing = db
      .prepare("SELECT desired, step_mode FROM run_controls WHERE run_id = ?")
      .get(params.runId) as { desired?: string; step_mode?: number } | undefined;
    const desired = params.desired ?? (existing?.desired as RunControlState) ?? "none";
    const stepMode = params.stepMode ?? (existing ? Boolean(existing.step_mode) : false);
    db.prepare(
      `INSERT INTO run_controls (run_id, job_id, desired, step_mode, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        job_id = excluded.job_id,
        desired = excluded.desired,
        step_mode = excluded.step_mode,
        updated_at = excluded.updated_at`,
    ).run(params.runId, params.jobId, desired, stepMode ? 1 : 0, now);
  });
}

export async function clearRunControlDesired(params: {
  env: Record<string, string | undefined>;
  runId: string;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    db.prepare("UPDATE run_controls SET desired = 'none', updated_at = ? WHERE run_id = ?").run(
      now,
      params.runId,
    );
  });
}

/**
 * Single source of truth for writing a terminal cancel transition: clears any
 * pending cancel intent, transitions stale waiting gate checkpoints to
 * "cancelled", marks the run/job cancelled, and appends a terminal
 * `control`/`cancelled` checkpoint. Approval-record resolution and resume-state
 * cleanup stay with the caller (cancel vs reject carry different intents and
 * approver identity). Callers without a live workflow context may pass runId/
 * jobId/rootRunId directly instead of a synthesized WorkflowExecutionContext.
 */
export async function recordTerminalCancel(params: {
  env: Record<string, string | undefined>;
  runId: string;
  jobId?: string;
  rootRunId?: string;
  parentRunId?: string | null;
  run?: WorkflowExecutionContext | null;
  stepId?: string | null;
  stepIndex?: number | null;
  stepPath?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<string | null> {
  const run = await getRun(params.env, params.runId).catch(() => null);
  const jobId = params.jobId ?? run?.jobId ?? params.runId;
  const rootRunId = params.rootRunId ?? run?.rootRunId ?? params.runId;
  const parentRunId = params.parentRunId ?? run?.parentRunId ?? null;
  await clearRunControlDesired({ env: params.env, runId: params.runId });
  if (!checkpointsEnabled(params.env)) {
    await updateRun({ env: params.env, runId: params.runId, status: "cancelled" });
    return null;
  }
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `UPDATE checkpoints SET status = 'cancelled', finished_at = ?
        WHERE run_id = ? AND status = 'waiting'
        AND step_type IN (${WAIT_GATE_STEP_TYPE_SQL})`,
    ).run(now, params.runId, ...WAIT_GATE_STEP_TYPES);
  });
  const checkpointId = await appendCheckpoint({
    env: params.env,
    run: params.run ?? undefined,
    runId: params.runId,
    jobId,
    rootRunId,
    parentRunId,
    stepId: params.stepId ?? null,
    stepIndex: params.stepIndex ?? null,
    stepPath: params.stepPath ?? null,
    stepType: "control",
    status: "cancelled",
    metadata: { reason: "cancel_requested", ...(params.metadata ?? {}) },
  });
  await updateRun({ env: params.env, runId: params.runId, status: "cancelled" });
  return checkpointId;
}

/**
 * Resolve the current head wait for a job/run. Job-scoped resume must follow the
 * durable head instead of any older waiting approval or checkpoint row.
 */
export async function resolveJobHeadWait(params: {
  env: Record<string, string | undefined>;
  jobId?: string | null;
  runId?: string | null;
}): Promise<JobWaitSnapshot | null> {
  if (!params.jobId && !params.runId) return null;
  return withRuntimeDb(params.env, (db) => {
    const scope = params.runId
      ? (db
          .prepare("SELECT job_id, latest_checkpoint_id, status FROM runs WHERE run_id = ?")
          .get(params.runId) as
          | { job_id?: string | null; latest_checkpoint_id?: string | null; status?: string | null }
          | undefined)
      : (db
          .prepare("SELECT job_id, latest_checkpoint_id, status FROM jobs WHERE job_id = ?")
          .get(params.jobId) as
          | { job_id?: string | null; latest_checkpoint_id?: string | null; status?: string | null }
          | undefined);
    if (!scope || scope.status !== "waiting") return null;

    const headCheckpoint = scope.latest_checkpoint_id
      ? ((db
          .prepare("SELECT * FROM checkpoints WHERE checkpoint_id = ?")
          .get(scope.latest_checkpoint_id) as any) ?? null)
      : null;
    const resolvedHead = checkpointRowToWaitSnapshot(db, headCheckpoint);
    if (resolvedHead) return resolvedHead;

    const fallbackCheckpoint = (
      params.runId
        ? db
            .prepare(
              `SELECT * FROM checkpoints
              WHERE status = 'waiting' AND run_id = ? AND step_type IN (${WAIT_GATE_STEP_TYPE_SQL})
              ORDER BY created_at DESC LIMIT 1`,
            )
            .get(params.runId, ...WAIT_GATE_STEP_TYPES)
        : db
            .prepare(
              `SELECT * FROM checkpoints
              WHERE status = 'waiting' AND job_id = ? AND step_type IN (${WAIT_GATE_STEP_TYPE_SQL})
              ORDER BY created_at DESC LIMIT 1`,
            )
            .get(scope.job_id ?? params.jobId, ...WAIT_GATE_STEP_TYPES)
    ) as any;
    const resolvedFallback = checkpointRowToWaitSnapshot(db, fallbackCheckpoint);
    if (resolvedFallback) return resolvedFallback;

    const approvalRow = (
      params.runId
        ? db
            .prepare(
              "SELECT * FROM approvals WHERE status = 'waiting' AND run_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(params.runId)
        : db
            .prepare(
              "SELECT * FROM approvals WHERE status = 'waiting' AND job_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(scope.job_id ?? params.jobId)
    ) as any;
    return approvalRowToWaitSnapshot(approvalRow);
  });
}

export async function findHeadResumeStateKey(params: {
  env: Record<string, string | undefined>;
  jobId?: string | null;
  runId?: string | null;
  allowedStepTypes?: readonly WaitGateStepType[];
}): Promise<string | null> {
  const wait = await resolveJobHeadWait(params);
  if (!wait?.stateKey) return null;
  if (
    params.allowedStepTypes &&
    !params.allowedStepTypes.includes(wait.stepType as WaitGateStepType)
  ) {
    return null;
  }
  return wait.stateKey;
}

export async function findLatestResumeStateKey(params: {
  env: Record<string, string | undefined>;
  jobId?: string | null;
  runId?: string | null;
}): Promise<string | null> {
  return findHeadResumeStateKey(params);
}

export async function findWaitingCheckpointByStateKey(params: {
  env: Record<string, string | undefined>;
  stateKey: string;
}): Promise<CheckpointRecord | null> {
  const rows = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare(
          `SELECT * FROM checkpoints
          WHERE status = 'waiting' AND step_type IN (${WAIT_GATE_STEP_TYPE_SQL})
          ORDER BY created_at DESC`,
        )
        .all(...WAIT_GATE_STEP_TYPES) as any[],
  );
  const row = rows.find((entry) => metadataStateKey(entry.metadata_json) === params.stateKey);
  return row ? rowToCheckpoint(row) : null;
}

export async function updateCheckpointStatus(params: {
  env: Record<string, string | undefined>;
  checkpointId: string;
  status: CheckpointRecord["status"];
  finishedAt?: string | null;
}) {
  await withRuntimeDb(params.env, (db) => {
    db.prepare("UPDATE checkpoints SET status = ?, finished_at = ? WHERE checkpoint_id = ?").run(
      params.status,
      params.finishedAt ?? new Date().toISOString(),
      params.checkpointId,
    );
  });
}

function metadataStateKey(metadataJson: string | null | undefined): string | null {
  const metadata = parseJsonSafe(metadataJson ?? null) as { stateKey?: unknown } | null;
  return metadata && typeof metadata.stateKey === "string" && metadata.stateKey
    ? metadata.stateKey
    : null;
}

function waitKindFromStepType(stepType: string | null | undefined): JobWaitKind | null {
  if (stepType === "pause") return "pause";
  if (stepType === "approval") return "approval";
  if (stepType === "input" || stepType === "pipeline_input") return "input";
  return null;
}

function checkpointRowToWaitSnapshot(db: any, row: any | null | undefined): JobWaitSnapshot | null {
  if (!row || row.status !== "waiting") return null;
  const kind = waitKindFromStepType(row.step_type);
  if (!kind) return null;

  const metadata = parseJsonSafe(row.metadata_json ?? null) as {
    stateKey?: unknown;
    approvalId?: unknown;
    reason?: unknown;
    nextStepId?: unknown;
  } | null;
  const stateKey =
    metadata && typeof metadata.stateKey === "string" && metadata.stateKey
      ? metadata.stateKey
      : null;
  const approval = (
    kind === "approval"
      ? db
          .prepare(
            `SELECT approval_id, state_key FROM approvals
            WHERE status = 'waiting'
              AND (checkpoint_id = ? OR (state_key IS NOT NULL AND state_key = ?))
            ORDER BY created_at DESC LIMIT 1`,
          )
          .get(row.checkpoint_id, stateKey)
      : null
  ) as { approval_id?: string | null; state_key?: string | null } | null;
  const reason =
    metadata?.reason === "pause_requested" || metadata?.reason === "step_mode"
      ? metadata.reason
      : null;
  const nextStepId =
    metadata && typeof metadata.nextStepId === "string" ? metadata.nextStepId : row.step_id;

  return {
    kind,
    checkpointId: row.checkpoint_id,
    stepId: row.step_id ?? null,
    stepType: row.step_type ?? null,
    stateKey: stateKey ?? approval?.state_key ?? null,
    approvalId:
      typeof metadata?.approvalId === "string"
        ? metadata.approvalId
        : (approval?.approval_id ?? null),
    ...(kind === "pause" ? { nextStepId, reason } : {}),
  };
}

function approvalRowToWaitSnapshot(row: any | null | undefined): JobWaitSnapshot | null {
  if (!row || row.status !== "waiting" || !row.state_key) return null;
  return {
    kind: "approval",
    checkpointId: row.checkpoint_id ?? null,
    stepId: null,
    stepType: "approval",
    stateKey: row.state_key,
    approvalId: row.approval_id ?? null,
  };
}

export async function listJobs(params: {
  env: Record<string, string | undefined>;
  status?: RunStatus;
  limit?: number;
  cursor?: string | null;
}): Promise<{ jobs: JobRecord[]; nextCursor: string | null }> {
  const limit = normalizeQueryLimit(params.limit);
  const cursor = decodeQueryCursor(params.cursor);
  const where: string[] = [];
  const values: string[] = [];
  if (params.status) {
    where.push("jobs.status = ?");
    values.push(params.status);
  }
  if (cursor) {
    where.push("(jobs.created_at < ? OR (jobs.created_at = ? AND jobs.job_id < ?))");
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = await withRuntimeDb(params.env, (db) => {
    const sql = `SELECT jobs.*,
      root_run.workflow_file AS root_workflow_file,
      root_run.workflow_name AS root_workflow_name,
      root_run.pipeline_text AS root_pipeline_text,
      root_run.workflow_description AS root_workflow_description,
      rc.desired AS control_desired,
      rc.step_mode AS control_step_mode,
      rc.updated_at AS control_updated_at
      FROM jobs
      LEFT JOIN runs AS root_run ON root_run.run_id = jobs.root_run_id
      LEFT JOIN run_controls rc ON rc.run_id = jobs.root_run_id${
        where.length ? ` WHERE ${where.join(" AND ")}` : ""
      } ORDER BY jobs.created_at DESC, jobs.job_id DESC LIMIT ?`;
    return db.prepare(sql).all(...values, limit + 1) as any[];
  });
  const pageRows = rows.slice(0, limit);
  const jobs = await Promise.all(
    pageRows.map(async (row) => {
      const job = await rowToJob(params.env, row);
      job.wait = await resolveJobHeadWait({ env: params.env, jobId: job.jobId });
      return job;
    }),
  );
  const next = rows.length > limit ? pageRows.at(-1) : null;
  return {
    jobs,
    nextCursor: next ? encodeQueryCursor({ createdAt: next.created_at, id: next.job_id }) : null,
  };
}

export async function listJobRuns(params: {
  env: Record<string, string | undefined>;
  jobId: string;
}): Promise<RunRecord[]> {
  const rows = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare(
          `SELECT
            runs.*,
            jobs.final_output_json,
            jobs.final_output_blob_id,
            rc.desired AS control_desired,
            rc.step_mode AS control_step_mode,
            rc.updated_at AS control_updated_at
          FROM runs
          JOIN jobs ON jobs.job_id = runs.job_id
          LEFT JOIN run_controls rc ON rc.run_id = runs.root_run_id
          WHERE runs.job_id = ?
          ORDER BY runs.depth, runs.created_at, runs.run_id`,
        )
        .all(params.jobId) as any[],
  );
  return Promise.all(rows.map((row) => rowToRun(params.env, row)));
}

export async function listPendingApprovals(params: {
  env: Record<string, string | undefined>;
  jobId?: string | null;
  runId?: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<{ approvals: ApprovalRecord[]; nextCursor: string | null }> {
  const limit = normalizeQueryLimit(params.limit);
  const cursor = decodeQueryCursor(params.cursor);
  const where = ["status = 'waiting'"];
  const values: string[] = [];
  if (params.jobId || params.runId) {
    const headWait = await resolveJobHeadWait({
      env: params.env,
      jobId: params.jobId,
      runId: params.runId,
    });
    if (headWait?.kind !== "approval") {
      return { approvals: [], nextCursor: null };
    }
    const headClauses: string[] = [];
    if (headWait.approvalId) {
      headClauses.push("approval_id = ?");
      values.push(headWait.approvalId);
    }
    if (headWait.checkpointId) {
      headClauses.push("checkpoint_id = ?");
      values.push(headWait.checkpointId);
    }
    if (headWait.stateKey) {
      headClauses.push("state_key = ?");
      values.push(headWait.stateKey);
    }
    if (!headClauses.length) {
      return { approvals: [], nextCursor: null };
    }
    where.push(`(${headClauses.join(" OR ")})`);
  }
  if (params.jobId) {
    where.push("job_id = ?");
    values.push(params.jobId);
  }
  if (params.runId) {
    where.push("run_id = ?");
    values.push(params.runId);
  }
  if (cursor) {
    where.push("(created_at < ? OR (created_at = ? AND approval_id < ?))");
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = await withRuntimeDb(params.env, (db) => {
    const sql = `SELECT * FROM approvals WHERE ${where.join(
      " AND ",
    )} ORDER BY created_at DESC, approval_id DESC LIMIT ?`;
    return db.prepare(sql).all(...values, limit + 1) as any[];
  });
  const pageRows = rows.slice(0, limit);
  return {
    approvals: pageRows.map(rowToApproval),
    nextCursor:
      rows.length > limit
        ? encodeQueryCursor({
            createdAt: pageRows.at(-1)!.created_at,
            id: pageRows.at(-1)!.approval_id,
          })
        : null,
  };
}

export async function appendCheckpoint(params: {
  env: Record<string, string | undefined>;
  run?: WorkflowExecutionContext | null;
  runId?: string;
  jobId?: string;
  rootRunId?: string;
  parentRunId?: string | null;
  stepId?: string | null;
  stepPath?: string | null;
  stepIndex?: number | null;
  stepType?: string | null;
  attempt?: number | null;
  status: CheckpointRecord["status"];
  startedAt?: string | null;
  finishedAt?: string | null;
  condition?: unknown;
  dependencyEdges?: unknown;
  metadata?: unknown;
  error?: unknown;
  exitStatus?: number | null;
  io?: CheckpointIORecord;
}) {
  const runId = params.runId ?? params.run?.runId;
  if (!runId) return null;
  const jobId = params.jobId ?? params.run?.jobId ?? runId;
  const rootRunId = params.rootRunId ?? params.run?.rootRunId ?? runId;
  const parentRunId = params.parentRunId ?? params.run?.parentRunId ?? null;
  const stepPath = params.stepPath ?? joinStepPath(params.run?.stepPathPrefix, params.stepId);
  const checkpointId = randomUUID();
  const createdAt = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `INSERT INTO checkpoints (
        checkpoint_id, job_id, run_id, root_run_id, parent_run_id,
        parent_checkpoint_id, step_id, step_path, step_index, step_type,
        attempt, status, started_at, finished_at, condition_json, dependency_edges_json,
        metadata_json, error_json, exit_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpointId,
      jobId,
      runId,
      rootRunId,
      parentRunId,
      params.run?.latestCheckpointId ?? null,
      params.stepId ?? null,
      stepPath,
      params.stepIndex ?? null,
      params.stepType ?? null,
      params.attempt ?? null,
      params.status,
      params.startedAt ?? createdAt,
      params.finishedAt ?? null,
      params.condition === undefined ? null : stringifySafe(params.condition),
      params.dependencyEdges === undefined ? null : stringifySafe(params.dependencyEdges),
      params.metadata === undefined ? null : stringifySafe(params.metadata),
      params.error === undefined ? null : stringifySafe(params.error),
      params.exitStatus ?? null,
      createdAt,
    );
    if (
      params.status === "waiting" &&
      params.stepType &&
      WAIT_GATE_STEP_TYPES.includes(params.stepType as WaitGateStepType)
    ) {
      db.prepare(
        `UPDATE checkpoints
        SET status = 'resumed', finished_at = ?
        WHERE run_id = ?
          AND status = 'waiting'
          AND step_type IN (${WAIT_GATE_STEP_TYPE_SQL})
          AND checkpoint_id != ?`,
      ).run(createdAt, runId, ...WAIT_GATE_STEP_TYPES, checkpointId);
      db.prepare(
        `UPDATE approvals
        SET status = 'cancelled', decision = 'superseded', resolved_at = ?
        WHERE run_id = ?
          AND status = 'waiting'
          AND checkpoint_id IS NOT NULL
          AND checkpoint_id != ?`,
      ).run(createdAt, runId, checkpointId);
    }
  });

  if (params.io) await writeCheckpointIO(params.env, checkpointId, params.io);
  if (params.run) params.run.latestCheckpointId = checkpointId;
  await updateRun({ env: params.env, runId, latestCheckpointId: checkpointId });
  return checkpointId;
}

export async function listRunCheckpoints(params: {
  env: Record<string, string | undefined>;
  runId: string;
}) {
  const rows = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY step_index, created_at")
        .all(params.runId) as any[],
  );
  return rows.map(rowToCheckpoint);
}

export async function listJobCheckpoints(params: {
  env: Record<string, string | undefined>;
  jobId: string;
}) {
  const rows = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare("SELECT * FROM checkpoints WHERE job_id = ? ORDER BY created_at")
        .all(params.jobId) as any[],
  );
  return rows.map(rowToCheckpoint);
}

export async function getCheckpoint(params: {
  env: Record<string, string | undefined>;
  checkpointId: string;
}) {
  const row = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare("SELECT * FROM checkpoints WHERE checkpoint_id = ?")
        .get(params.checkpointId) as any,
  );
  return row ? rowToCheckpoint(row) : null;
}

export async function getCheckpointIO(params: {
  env: Record<string, string | undefined>;
  checkpointId: string;
}) {
  const row = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare("SELECT * FROM checkpoint_io WHERE checkpoint_id = ?")
        .get(params.checkpointId) as any,
  );
  if (!row) return null;
  return {
    checkpointId: params.checkpointId,
    stdin: await readInlineOrBlob(params.env, row.stdin_preview_json, row.stdin_blob_id),
    stdout: await readInlineOrBlob(params.env, row.stdout_preview_json, row.stdout_blob_id),
    stderr: await readInlineOrBlob(params.env, row.stderr_preview_json, row.stderr_blob_id),
    jsonInput: await readInlineOrBlob(
      params.env,
      row.json_input_preview_json,
      row.json_input_blob_id,
    ),
    jsonOutput: await readInlineOrBlob(
      params.env,
      row.json_output_preview_json,
      row.json_output_blob_id,
    ),
  };
}

export async function createApprovalRecord(params: {
  env: Record<string, string | undefined>;
  approvalId: string;
  run?: WorkflowExecutionContext | null;
  jobId?: string | null;
  runId?: string | null;
  rootRunId?: string | null;
  parentRunId?: string | null;
  checkpointId?: string | null;
  stepPath?: string | null;
  stateKey?: string | null;
  prompt?: string | null;
  metadata?: unknown;
  initiatedBy?: string | null;
  requiredApprover?: string | null;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `INSERT OR REPLACE INTO approvals (
        approval_id, job_id, run_id, root_run_id, parent_run_id, checkpoint_id,
        step_path, state_key, status, prompt, metadata_json,
        initiated_by, required_approver, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.approvalId,
      params.jobId ?? params.run?.jobId ?? null,
      params.runId ?? params.run?.runId ?? null,
      params.rootRunId ?? params.run?.rootRunId ?? null,
      params.parentRunId ?? params.run?.parentRunId ?? null,
      params.checkpointId ?? params.run?.latestCheckpointId ?? null,
      params.stepPath ?? null,
      params.stateKey ?? null,
      "waiting",
      params.prompt ?? null,
      params.metadata === undefined ? null : stringifySafe(params.metadata),
      params.initiatedBy ?? null,
      params.requiredApprover ?? null,
      now,
    );
  });
}

export async function resolveApprovalRecord(params: {
  env: Record<string, string | undefined>;
  approvalId?: string | null;
  stateKey?: string | null;
  status: ApprovalRecord["status"];
  decision?: string | null;
  approvedBy?: string | null;
}) {
  const now = new Date().toISOString();
  await withRuntimeDb(params.env, (db) => {
    if (params.approvalId) {
      db.prepare(
        `UPDATE approvals SET status = ?, decision = ?, approved_by = ?, resolved_at = ? WHERE approval_id = ?`,
      ).run(
        params.status,
        params.decision ?? null,
        params.approvedBy ?? null,
        now,
        params.approvalId,
      );
      return;
    }
    if (params.stateKey) {
      db.prepare(
        `UPDATE approvals SET status = ?, decision = ?, approved_by = ?, resolved_at = ? WHERE state_key = ? AND status = 'waiting'`,
      ).run(
        params.status,
        params.decision ?? null,
        params.approvedBy ?? null,
        now,
        params.stateKey,
      );
    }
  });
}

export async function readCacheEntry(params: {
  env: Record<string, string | undefined>;
  namespace: string;
  cacheKey: string;
}): Promise<CacheEntryRecord | null> {
  const now = new Date().toISOString();
  const row = await withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare("SELECT * FROM cache_entries WHERE namespace = ? AND cache_key = ?")
        .get(params.namespace, params.cacheKey) as any,
  );
  if (!row) return null;
  if (row.expires_at && row.expires_at <= now) return null;

  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `UPDATE cache_entries SET last_accessed_at = ?, hit_count = hit_count + 1 WHERE namespace = ? AND cache_key = ?`,
    ).run(now, params.namespace, params.cacheKey);
  });

  const output =
    row.output_inline_json !== null && row.output_inline_json !== undefined
      ? parseJsonSafe(row.output_inline_json)
      : row.output_blob_id
        ? await readBlobJson({ env: params.env, blobId: row.output_blob_id })
        : [];
  return {
    namespace: row.namespace,
    cacheKey: row.cache_key,
    items: Array.isArray(output) ? output : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: now,
    expiresAt: row.expires_at,
    hitCount: Number(row.hit_count ?? 0) + 1,
  };
}

export async function writeCacheEntry(params: {
  env: Record<string, string | undefined>;
  entry: CacheEntry;
}) {
  const now = new Date().toISOString();
  const inlineMaxBytes = resolveCacheInlineBytes(params.env);
  const inputPayload = await storePayload({
    env: params.env,
    value: params.entry.input ?? null,
    inlineMaxBytes,
  });
  const outputPayload = await storePayload({
    env: params.env,
    value: params.entry.items,
    inlineMaxBytes,
  });
  if (inputPayload.blob) await upsertBlob(params.env, inputPayload.blob);
  if (outputPayload.blob) await upsertBlob(params.env, outputPayload.blob);

  await withRuntimeDb(params.env, (db) => {
    db.prepare(
      `INSERT INTO cache_entries (
        namespace, cache_key, input_hash, output_hash, input_inline_json, output_inline_json,
        input_preview_json, output_preview_json, input_blob_id, output_blob_id,
        provider, model, tool, action, schema_hash, status,
        created_at, updated_at, last_accessed_at, expires_at, hit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, cache_key) DO UPDATE SET
        input_hash = excluded.input_hash,
        output_hash = excluded.output_hash,
        input_inline_json = excluded.input_inline_json,
        output_inline_json = excluded.output_inline_json,
        input_preview_json = excluded.input_preview_json,
        output_preview_json = excluded.output_preview_json,
        input_blob_id = excluded.input_blob_id,
        output_blob_id = excluded.output_blob_id,
        provider = excluded.provider,
        model = excluded.model,
        tool = excluded.tool,
        action = excluded.action,
        schema_hash = excluded.schema_hash,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at,
        expires_at = excluded.expires_at`,
    ).run(
      params.entry.namespace,
      params.entry.cacheKey,
      inputPayload.sha256,
      outputPayload.sha256,
      inputPayload.inlineJson,
      outputPayload.inlineJson,
      inputPayload.previewJson,
      outputPayload.previewJson,
      inputPayload.blobId,
      outputPayload.blobId,
      params.entry.provider ?? null,
      params.entry.model ?? null,
      params.entry.tool ?? null,
      params.entry.action ?? null,
      params.entry.schemaHash ?? null,
      params.entry.status ?? "ok",
      now,
      now,
      now,
      params.entry.expiresAt ?? defaultCacheExpiresAt(params.env, now),
      0,
    );
  });
}

export async function expireCacheEntries(params: {
  env: Record<string, string | undefined>;
  now?: string;
}) {
  const now = params.now ?? new Date().toISOString();
  return withRuntimeDb(
    params.env,
    (db) =>
      db
        .prepare("DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?")
        .run(now).changes,
  );
}

async function writeCheckpointIO(
  env: Record<string, string | undefined>,
  checkpointId: string,
  io: CheckpointIORecord,
) {
  const inlineMaxBytes = resolveCheckpointInlineBytes(env);
  const previewBytes = resolveCheckpointPreviewBytes(env);
  const stdinPayload = await optionalPayload(env, io.stdin, inlineMaxBytes, previewBytes);
  const stdoutPayload = await optionalPayload(env, io.stdout, inlineMaxBytes, previewBytes);
  const stderrPayload = await optionalPayload(env, io.stderr, inlineMaxBytes, previewBytes);
  const jsonInputPayload = await optionalPayload(env, io.jsonInput, inlineMaxBytes, previewBytes);
  const jsonOutputPayload = await optionalPayload(env, io.jsonOutput, inlineMaxBytes, previewBytes);

  for (const payload of [
    stdinPayload,
    stdoutPayload,
    stderrPayload,
    jsonInputPayload,
    jsonOutputPayload,
  ]) {
    if (payload?.blob) await upsertBlob(env, payload.blob);
  }

  await withRuntimeDb(env, (db) => {
    db.prepare(
      `INSERT OR REPLACE INTO checkpoint_io (
        checkpoint_id, stdin_preview_json, stdin_blob_id, stdout_preview_json, stdout_blob_id,
        stderr_preview_json, stderr_blob_id, json_input_preview_json, json_input_blob_id,
        json_output_preview_json, json_output_blob_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpointId,
      stdinPayload?.previewJson ?? null,
      stdinPayload?.blobId ?? null,
      stdoutPayload?.previewJson ?? null,
      stdoutPayload?.blobId ?? null,
      stderrPayload?.previewJson ?? null,
      stderrPayload?.blobId ?? null,
      jsonInputPayload?.previewJson ?? null,
      jsonInputPayload?.blobId ?? null,
      jsonOutputPayload?.previewJson ?? null,
      jsonOutputPayload?.blobId ?? null,
      new Date().toISOString(),
    );
  });
}

async function optionalPayload(
  env: Record<string, string | undefined>,
  value: unknown,
  inlineMaxBytes: number,
  previewBytes: number,
) {
  if (value === undefined) return null;
  return storePayload({ env, value, inlineMaxBytes, previewBytes });
}

async function upsertBlob(env: Record<string, string | undefined>, blob: BlobRecord) {
  await withRuntimeDb(env, (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO blobs (blob_id, sha256, byte_length, content_type, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      blob.blobId,
      blob.sha256,
      blob.byteLength,
      blob.contentType,
      blob.storagePath,
      blob.createdAt,
    );
  });
}

async function readInlineOrBlob(
  env: Record<string, string | undefined>,
  previewJson: string | null,
  blobId: string | null,
) {
  if (blobId) return readBlobJson({ env, blobId });
  return parseJsonSafe(previewJson);
}

async function rowToJob(env: Record<string, string | undefined>, row: any): Promise<JobRecord> {
  const finalOutput =
    row.final_output_json !== null && row.final_output_json !== undefined
      ? parseJsonSafe(row.final_output_json)
      : row.final_output_blob_id
        ? await readBlobJson({ env, blobId: row.final_output_blob_id })
        : undefined;
  return {
    jobId: row.job_id,
    rootRunId: row.root_run_id,
    status: row.status,
    sourceType: row.source_type,
    parentJobId: row.parent_job_id ?? null,
    rootJobId: row.root_job_id ?? null,
    latestRunId: row.latest_run_id ?? null,
    finalOutput,
    finalOutputBlobId: row.final_output_blob_id,
    latestCheckpointId: row.latest_checkpoint_id,
    externalProvider: row.external_provider ?? null,
    externalAgentId: row.external_agent_id ?? null,
    externalSessionId: row.external_session_id ?? null,
    externalSessionKey: row.external_session_key ?? null,
    agent: row.agent ?? null,
    model: row.model ?? null,
    title: row.title ?? null,
    description: row.description ?? null,
    metadata:
      row.metadata_json === null || row.metadata_json === undefined
        ? null
        : (parseJsonSafe(row.metadata_json) as Record<string, unknown> | null),
    workflowFile: row.root_workflow_file ?? null,
    workflowName: row.root_workflow_name ?? null,
    workflowDescription: row.root_workflow_description ?? null,
    pipelineText: row.root_pipeline_text ?? null,
    control: controlSnapshotFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function controlSnapshotFromRow(row: any): RunControlSnapshot {
  return {
    stepMode: Boolean(row.control_step_mode),
    desired: (row.control_desired as RunControlState) ?? "none",
    ...(row.control_updated_at !== null && row.control_updated_at !== undefined
      ? { updatedAt: row.control_updated_at }
      : {}),
  };
}

function rowToCheckpoint(row: any): CheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    jobId: row.job_id,
    runId: row.run_id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    parentCheckpointId: row.parent_checkpoint_id,
    stepId: row.step_id,
    stepPath: row.step_path,
    stepIndex: row.step_index,
    stepType: row.step_type,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    condition: parseJsonSafe(row.condition_json),
    dependencyEdges: parseJsonSafe(row.dependency_edges_json),
    metadata: parseJsonSafe(row.metadata_json),
    error: parseJsonSafe(row.error_json),
    exitStatus: row.exit_status,
    createdAt: row.created_at,
  };
}

async function rowToRun(env: Record<string, string | undefined>, row: any): Promise<RunRecord> {
  const finalOutput =
    row.final_output_json !== null && row.final_output_json !== undefined
      ? parseJsonSafe(row.final_output_json)
      : row.final_output_blob_id
        ? await readBlobJson({ env, blobId: row.final_output_blob_id })
        : undefined;
  return {
    jobId: row.job_id,
    runId: row.run_id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    parentStepId: row.parent_step_id,
    parentStepPath: row.parent_step_path,
    rewindOfCheckpointId: row.rewind_of_checkpoint_id ?? null,
    status: row.status,
    sourceType: row.source_type,
    workflowFile: row.workflow_file,
    workflowName: row.workflow_name,
    pipelineText: row.pipeline_text,
    workflowDescription: row.workflow_description ?? null,
    args: parseJsonSafe(row.args_json),
    depth: Number(row.depth ?? 0),
    finalOutput,
    finalOutputBlobId: row.final_output_blob_id,
    latestCheckpointId: row.latest_checkpoint_id,
    control: controlSnapshotFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApproval(row: any): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    jobId: row.job_id,
    runId: row.run_id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    checkpointId: row.checkpoint_id,
    stepPath: row.step_path,
    stateKey: row.state_key,
    status: row.status,
    prompt: row.prompt,
    metadata: parseJsonSafe(row.metadata_json),
    decision: row.decision,
    initiatedBy: row.initiated_by,
    requiredApprover: row.required_approver,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

type QueryCursor = { createdAt: string; id: string };

function encodeQueryCursor(cursor: QueryCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeQueryCursor(cursor: string | null | undefined): QueryCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string"
    ) {
      return parsed;
    }
  } catch {
    // Throw a consistent public error below.
  }
  throw new Error("Invalid pagination cursor");
}

function normalizeQueryLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_QUERY_LIMIT;
  return Math.min(Math.floor(limit), MAX_QUERY_LIMIT);
}

function joinStepPath(prefix: string | null | undefined, stepId: string | null | undefined) {
  if (!stepId) return prefix ?? null;
  return prefix ? `${prefix}.${stepId}` : stepId;
}

function resolveCheckpointInlineBytes(env: Record<string, string | undefined>) {
  return parsePositiveInt(env.LOBSTER_CHECKPOINT_INLINE_MAX_BYTES, DEFAULT_CHECKPOINT_INLINE_BYTES);
}

function resolveCheckpointPreviewBytes(env: Record<string, string | undefined>) {
  return parsePositiveInt(env.LOBSTER_CHECKPOINT_MAX_BYTES, DEFAULT_CHECKPOINT_PREVIEW_BYTES);
}

function resolveCacheInlineBytes(env: Record<string, string | undefined>) {
  return parsePositiveInt(env.LOBSTER_CACHE_INLINE_MAX_BYTES, DEFAULT_CACHE_INLINE_BYTES);
}

function defaultCacheExpiresAt(env: Record<string, string | undefined>, now: string) {
  const days = Number(env.LOBSTER_CACHE_TTL_DAYS ?? DEFAULT_CACHE_TTL_DAYS);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.parse(now) + Math.floor(days * 24 * 60 * 60 * 1000)).toISOString();
}

function normalizeStoredJobText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
