import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

/**
 * Exactly one process opens this file.
 *
 * A second writer silently loses rows and makes reads report corruption — this
 * is a scar, not a theory. The Python sidecar never touches it: it reads audio,
 * writes JSON, and returns results; Node owns all persistence.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // WAL lets a reader proceed while a write is in flight, which is what makes
  // the desktop app's list views safe to render mid-run.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

function currentVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

function applyMigrations(db: Db): void {
  const from = currentVersion(db);

  if (from === 0) {
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    // Each migration is its own transaction: a failure half-way leaves the
    // database at the last version that fully applied, not somewhere between.
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    })();
  }
}

export function schemaVersion(db: Db): number {
  return currentVersion(db);
}

/**
 * A crash leaves rows claiming to be running forever. Called at startup so the
 * UI never shows a run that has not existed since the last boot.
 */
export function resolveOrphanedRuns(db: Db): { stageRuns: number; agentRuns: number } {
  const now = new Date().toISOString();
  const stage = db
    .prepare(
      `UPDATE stage_runs SET status = 'interrupted', finished_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(now);
  const agent = db
    .prepare(
      `UPDATE agent_runs SET status = 'interrupted', finished_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(now);
  return { stageRuns: stage.changes, agentRuns: agent.changes };
}

export function closeDb(db: Db): void {
  db.close();
}
