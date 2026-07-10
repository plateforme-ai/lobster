import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getPrefixDir, getStateDir, ensureDirectory } from "./helpers.js";

// Current schema version
const SCHEMA_VERSION = 1;

// Schema migrations
const MIGRATIONS = [
  {
    id: 1,
    sql: `
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
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
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

      CREATE INDEX idx_checkpoints_job_seq ON checkpoints(job_id, seq);
      CREATE INDEX idx_checkpoints_run_seq ON checkpoints(run_id, seq);
      CREATE INDEX idx_checkpoints_run_kind ON checkpoints(run_id, kind, seq);
      CREATE INDEX idx_checkpoints_step_path ON checkpoints(run_id, step_path, seq);
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
    `,
  },
];

export async function openRuntimeDb(env: Record<string, string | undefined>) {
  const dbPath = resolveRuntimeDbPath(env);
  const dir = path.dirname(dbPath);
  await ensureDirectory(dir);
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
  // Fast path: an already-migrated DB is the common case (every open after the
  // first). Skipping the write lock here means concurrent openers never contend
  // once the schema exists — only the very first open per DB takes a lock.
  if (isCurrentSchema(db)) return;

  db.exec("BEGIN IMMEDIATE;");
  try {
    // Re-read under the write lock: a concurrent opener may have migrated while
    // we waited on busy_timeout for the lock, so the version can now be current.
    const version = readUserVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is greater than current schema version ${SCHEMA_VERSION}`,
      );
    }
    if (version === SCHEMA_VERSION) {
      db.exec("COMMIT;");
      return;
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );`,
    );
    for (const migration of MIGRATIONS) {
      if (migration.id > SCHEMA_VERSION) break;
      const existing = db.prepare("SELECT id FROM migrations WHERE id = ?").get(migration.id) as
        | { id?: number }
        | undefined;
      if (existing?.id) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(
        migration.id,
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    // Roll back and surface the real failure. The previous code committed in a
    // `finally`, which threw "cannot commit - no transaction is active" after
    // this rollback and masked the underlying error.
    db.exec("ROLLBACK;");
    throw error;
  }
}

function isCurrentSchema(db: DatabaseSync): boolean {
  return readUserVersion(db) === SCHEMA_VERSION;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
