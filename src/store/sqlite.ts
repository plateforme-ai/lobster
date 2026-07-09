import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getPrefixDir, getStateDir, ensureDirectory } from "./helpers.js";

// Fresh schema v1. There is no migration path: an incompatible on-disk database
// (any user_version other than SCHEMA_VERSION) is dropped and recreated. Bump
// SCHEMA_VERSION whenever this DDL changes in a way that invalidates old data.
const SCHEMA_VERSION = 1;

// Every table this schema owns. Dropped in order (children before parents) when
// resetting an incompatible database so the fresh DDL applies to a clean slate.
const OWNED_TABLES = [
  "checkpoint_io",
  "approvals",
  "run_controls",
  "checkpoints",
  "runs",
  "jobs",
  "cache_entries",
  "blobs",
  "schema_migrations",
];

const SCHEMA_SQL = `
  CREATE TABLE blobs (
    blob_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    byte_length INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    root_run_id TEXT,
    status TEXT NOT NULL,
    source_type TEXT NOT NULL,
    parent_job_id TEXT,
    root_job_id TEXT,
    latest_run_id TEXT,
    final_output_json TEXT,
    final_output_blob_id TEXT,
    latest_checkpoint_id TEXT,
    external_session_key TEXT,
    external_session_id TEXT,
    external_provider TEXT,
    external_agent_id TEXT,
    agent TEXT,
    model TEXT,
    title TEXT,
    description TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);
  CREATE INDEX idx_jobs_parent ON jobs(parent_job_id);
  CREATE INDEX idx_jobs_root ON jobs(root_job_id);

  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    root_run_id TEXT,
    parent_run_id TEXT,
    parent_step_id TEXT,
    parent_step_path TEXT,
    rewind_of_checkpoint_id TEXT,
    status TEXT NOT NULL,
    source_type TEXT NOT NULL,
    workflow_file TEXT,
    workflow_name TEXT,
    workflow_description TEXT,
    pipeline_text TEXT,
    args_json TEXT,
    latest_checkpoint_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(job_id)
  );

  CREATE INDEX idx_runs_status_created ON runs(status, created_at);
  CREATE INDEX idx_runs_job_depth ON runs(job_id, depth, created_at);
  CREATE INDEX idx_runs_parent ON runs(parent_run_id);

  CREATE TABLE checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    root_run_id TEXT NOT NULL,
    parent_run_id TEXT,
    step_id TEXT,
    step_path TEXT,
    step_index INTEGER,
    step_type TEXT,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    metadata_json TEXT,
    resume_state_json TEXT,
    error_json TEXT,
    exit_status INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(job_id),
    FOREIGN KEY(run_id) REFERENCES runs(run_id)
  );

  CREATE INDEX idx_checkpoints_run_seq ON checkpoints(run_id, seq);
  CREATE INDEX idx_checkpoints_job_seq ON checkpoints(job_id, seq);
  CREATE INDEX idx_checkpoints_step_path ON checkpoints(job_id, step_path);
  CREATE INDEX idx_checkpoints_status ON checkpoints(status, created_at);

  CREATE TABLE checkpoint_io (
    checkpoint_id TEXT PRIMARY KEY,
    stdin_preview_json TEXT,
    stdin_blob_id TEXT,
    stdout_preview_json TEXT,
    stdout_blob_id TEXT,
    stderr_preview_json TEXT,
    stderr_blob_id TEXT,
    json_input_preview_json TEXT,
    json_input_blob_id TEXT,
    json_output_preview_json TEXT,
    json_output_blob_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(checkpoint_id)
  );

  CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    job_id TEXT,
    run_id TEXT,
    root_run_id TEXT,
    parent_run_id TEXT,
    checkpoint_id TEXT,
    step_path TEXT,
    status TEXT NOT NULL,
    prompt TEXT,
    metadata_json TEXT,
    decision TEXT,
    initiated_by TEXT,
    required_approver TEXT,
    approved_by TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX idx_approvals_status_created ON approvals(status, created_at);
  CREATE INDEX idx_approvals_job ON approvals(job_id);
  CREATE INDEX idx_approvals_run ON approvals(run_id);
  CREATE INDEX idx_approvals_checkpoint ON approvals(checkpoint_id);

  CREATE TABLE run_controls (
    run_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    desired TEXT NOT NULL DEFAULT 'none',
    step_mode INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id),
    FOREIGN KEY(job_id) REFERENCES jobs(job_id)
  );

  CREATE INDEX idx_run_controls_job ON run_controls(job_id);

  CREATE TABLE cache_entries (
    namespace TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    input_hash TEXT,
    output_hash TEXT,
    input_inline_json TEXT,
    output_inline_json TEXT,
    input_preview_json TEXT,
    output_preview_json TEXT,
    input_blob_id TEXT,
    output_blob_id TEXT,
    provider TEXT,
    model TEXT,
    tool TEXT,
    action TEXT,
    schema_hash TEXT,
    status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    expires_at TEXT,
    hit_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(namespace, cache_key)
  );

  CREATE INDEX idx_cache_expires ON cache_entries(expires_at);
  CREATE INDEX idx_cache_namespace_accessed ON cache_entries(namespace, last_accessed_at);
`;

export async function openRuntimeDb(env: Record<string, string | undefined>) {
  const dbPath = resolveRuntimeDbPath(env);
  const dir = path.dirname(dbPath);
  await ensureDirectory(dir);
  await ensureDirectory(getStateDir(env));
  const db = new DatabaseSync(dbPath);
  configureDb(db, env);
  migrateDb(db);
  return db;
}

export async function withRuntimeDb<T>(
  env: Record<string, string | undefined>,
  fn: (db: DatabaseSync) => T | Promise<T>,
) {
  const db = await openRuntimeDb(env);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export function resolveRuntimeDbPath(env: Record<string, string | undefined>) {
  return path.join(getPrefixDir(env), "lobster.db");
}

function configureDb(db: DatabaseSync, env: Record<string, string | undefined>) {
  const busyTimeout = parsePositiveInt(env.LOBSTER_SQLITE_BUSY_TIMEOUT_MS, 5000);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = ${busyTimeout};`);
}

function migrateDb(db: DatabaseSync) {
  // Fresh v1: the schema is defined by a single DDL and versioned via
  // `PRAGMA user_version`. There is no in-place migration path. A brand-new
  // database (user_version 0, no tables) is created from the DDL. Any database
  // stamped with a different version predates this schema and is discarded and
  // recreated — the plan accepts that existing jobs/checkpoints do not carry
  // over.
  if (schemaIsCurrent(db)) return;

  // Serialize the (one-time) reset+create across concurrent openers of the same
  // file: BEGIN IMMEDIATE takes the write lock (waiting up to busy_timeout), and
  // we re-check inside so only the first writer rebuilds; the rest observe the
  // stamped version and no-op.
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (schemaIsCurrent(db)) {
      db.exec("COMMIT;");
      return;
    }
    const current = readUserVersion(db);
    if (current !== 0 || !hasTable(db, "checkpoints")) {
      resetSchema(db);
    }
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

function schemaIsCurrent(db: DatabaseSync): boolean {
  return readUserVersion(db) === SCHEMA_VERSION && hasTable(db, "checkpoints");
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function resetSchema(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const table of OWNED_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  db.exec("PRAGMA foreign_keys = ON;");
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
