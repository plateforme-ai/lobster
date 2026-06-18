import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultStateDir, ensureDirectory } from "../state/store.js";

const MIGRATIONS = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blobs (
        blob_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        byte_length INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        root_run_id TEXT,
        status TEXT NOT NULL,
        source_type TEXT NOT NULL,
        rerun_of_job_id TEXT,
        rewind_of_job_id TEXT,
        rewind_of_checkpoint_id TEXT,
        final_output_json TEXT,
        final_output_blob_id TEXT,
        latest_checkpoint_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_lineage ON jobs(rerun_of_job_id, rewind_of_job_id);

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        root_run_id TEXT,
        parent_run_id TEXT,
        parent_step_id TEXT,
        parent_step_path TEXT,
        status TEXT NOT NULL,
        source_type TEXT NOT NULL,
        workflow_file TEXT,
        workflow_name TEXT,
        pipeline_text TEXT,
        args_json TEXT,
        latest_checkpoint_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(job_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_job_depth ON runs(job_id, depth, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        root_run_id TEXT NOT NULL,
        parent_run_id TEXT,
        parent_checkpoint_id TEXT,
        step_id TEXT,
        step_path TEXT,
        step_index INTEGER,
        step_type TEXT,
        attempt INTEGER,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        condition_json TEXT,
        dependency_edges_json TEXT,
        metadata_json TEXT,
        error_json TEXT,
        exit_status INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(job_id),
        FOREIGN KEY(run_id) REFERENCES runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_run_step ON checkpoints(run_id, step_index, created_at);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_job_created ON checkpoints(job_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_step_path ON checkpoints(job_id, step_path);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(status, created_at);

      CREATE TABLE IF NOT EXISTS checkpoint_io (
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

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        job_id TEXT,
        run_id TEXT,
        root_run_id TEXT,
        parent_run_id TEXT,
        checkpoint_id TEXT,
        step_path TEXT,
        state_key TEXT,
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

      CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals(job_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);

      CREATE TABLE IF NOT EXISTS cache_entries (
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

      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cache_namespace_accessed ON cache_entries(namespace, last_accessed_at);
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
  const explicit = String(env?.LOBSTER_SQLITE_PATH ?? "").trim();
  if (explicit) return explicit;
  if (env?.LOBSTER_STATE_DIR) return path.join(defaultStateDir(env), "lobster.db");
  const cacheDir = String(env?.LOBSTER_CACHE_DIR ?? "").trim();
  if (cacheDir) return `${cacheDir}.lobster.db`;
  return path.join(defaultStateDir(env), "lobster.db");
}

function configureDb(db: DatabaseSync, env: Record<string, string | undefined>) {
  const busyTimeout = parsePositiveInt(env.LOBSTER_SQLITE_BUSY_TIMEOUT_MS, 5000);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = ${busyTimeout};`);
}

function migrateDb(db: DatabaseSync) {
  db.exec(MIGRATIONS[0].sql);
  for (const migration of MIGRATIONS) {
    const existing = db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(migration.id) as { id?: number } | undefined;
    if (existing?.id) continue;
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migration.id,
      new Date().toISOString(),
    );
  }
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
