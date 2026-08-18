/**
 * The schema, embedded rather than shipped as a loose `schema.sql`.
 *
 * A `.sql` file would need a copy step in the build, and a missed copy is a
 * runtime failure that typechecking cannot catch — the database would open and
 * then fail on first query. Embedding makes it impossible to ship a build
 * without its schema.
 *
 * Everything here is `IF NOT EXISTS`: opening an existing database is a no-op.
 * Changes after v1 go in MIGRATIONS below and must be additive.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL
);

-- An index over the session folders, never their source of truth. Deleting
-- this database costs nothing but the time to rebuild it from disk.
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  number       INTEGER,
  date         TEXT NOT NULL,
  root_path    TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'new',
  grade        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_date ON sessions (date DESC);

CREATE TABLE IF NOT EXISTS stage_runs (
  stage_run_id TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,
  skipped      INTEGER NOT NULL DEFAULT 0,
  params_hash  TEXT,
  error        TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  duration_s   REAL
);
CREATE INDEX IF NOT EXISTS stage_runs_by_session ON stage_runs (session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS stage_runs_by_stage ON stage_runs (stage, started_at DESC);

-- Provider-neutral ledger for headless CLI runs (claude / codex / local).
-- Credentials are never stored here: only env or keychain references.
CREATE TABLE IF NOT EXISTS agent_runs (
  agent_run_id    TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions (session_id) ON DELETE SET NULL,
  provider        TEXT NOT NULL,
  model           TEXT,
  purpose         TEXT,
  prompt          TEXT,
  permission_mode TEXT,
  status          TEXT NOT NULL,
  result_text     TEXT,
  error           TEXT,
  transcript_path TEXT,
  num_turns       INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_cost_usd  REAL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS agent_runs_by_session ON agent_runs (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_by_provider ON agent_runs (provider, created_at DESC);

-- Where the pipeline declined to decide. The review UI groups by code.
CREATE TABLE IF NOT EXISTS flags (
  flag_id      TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,
  utterance_id TEXT,
  code         TEXT NOT NULL,
  reason       TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'warning',
  status       TEXT NOT NULL DEFAULT 'open',
  resolution   TEXT,
  resolved_by  TEXT,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flags_by_session ON flags (session_id, status, code);
CREATE UNIQUE INDEX IF NOT EXISTS flags_identity
  ON flags (session_id, stage, code, COALESCE(utterance_id, ''));

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Additive only: new tables, new indexes, `ALTER TABLE ... ADD COLUMN`. Never a
 * drop, a rename, or a type change — an older build must still be able to open
 * a newer database and read what it understands.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = Object.freeze([]);

/** Bumped whenever SCHEMA_SQL or MIGRATIONS change. */
export const SCHEMA_VERSION = 1 + MIGRATIONS.length;
