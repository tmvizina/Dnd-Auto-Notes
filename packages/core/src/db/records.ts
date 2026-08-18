import type { Db } from "./db.js";
import { newId } from "./ids.js";

/**
 * Row shapes and the writes that produce them. Everything here mirrors state
 * that already exists on disk — the database is an index and a ledger, never
 * the only home of a fact.
 */

export interface SessionRow {
  session_id: string;
  title: string;
  number: number | null;
  date: string;
  root_path: string;
  status: string;
  grade: string | null;
  created_at: string;
  updated_at: string;
}

export interface StageRunRow {
  stage_run_id: string;
  session_id: string;
  stage: string;
  version: number;
  status: string;
  skipped: number;
  params_hash: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_s: number | null;
}

export interface AgentRunRow {
  agent_run_id: string;
  session_id: string | null;
  provider: string;
  model: string | null;
  purpose: string | null;
  status: string;
  result_text: string | null;
  error: string | null;
  transcript_path: string | null;
  num_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_cost_usd: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface FlagRow {
  flag_id: string;
  session_id: string;
  stage: string;
  utterance_id: string | null;
  code: string;
  reason: string;
  severity: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const now = (): string => new Date().toISOString();

// --- sessions --------------------------------------------------------------

export function upsertSession(
  db: Db,
  session: {
    session_id: string;
    title: string;
    number: number | null;
    date: string;
    root_path: string;
    status?: string;
    grade?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, title, number, date, root_path, status, grade, created_at, updated_at)
     VALUES (@session_id, @title, @number, @date, @root_path, @status, @grade, @created_at, @updated_at)
     ON CONFLICT (session_id) DO UPDATE SET
       title = excluded.title,
       number = excluded.number,
       date = excluded.date,
       root_path = excluded.root_path,
       status = excluded.status,
       grade = excluded.grade,
       updated_at = excluded.updated_at`,
  ).run({
    ...session,
    status: session.status ?? "new",
    grade: session.grade ?? null,
    created_at: now(),
    updated_at: now(),
  });
}

export function listSessions(db: Db): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions ORDER BY date DESC, session_id DESC")
    .all() as SessionRow[];
}

export function getSession(db: Db, sessionId: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    SessionRow | undefined;
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
}

// --- stage runs ------------------------------------------------------------

export function recordStageRun(
  db: Db,
  run: {
    session_id: string;
    stage: string;
    version: number;
    status: string;
    skipped?: boolean;
    params_hash?: string | null;
    error?: string | null;
    started_at: string;
    finished_at?: string | null;
    duration_s?: number | null;
  },
): string {
  const id = newId("srun");
  db.prepare(
    `INSERT INTO stage_runs
       (stage_run_id, session_id, stage, version, status, skipped, params_hash, error, started_at, finished_at, duration_s)
     VALUES (@stage_run_id, @session_id, @stage, @version, @status, @skipped, @params_hash, @error, @started_at, @finished_at, @duration_s)`,
  ).run({
    stage_run_id: id,
    session_id: run.session_id,
    stage: run.stage,
    version: run.version,
    status: run.status,
    skipped: run.skipped === true ? 1 : 0,
    params_hash: run.params_hash ?? null,
    error: run.error ?? null,
    started_at: run.started_at,
    finished_at: run.finished_at ?? null,
    duration_s: run.duration_s ?? null,
  });
  return id;
}

export function listStageRuns(db: Db, sessionId: string): StageRunRow[] {
  return db
    .prepare("SELECT * FROM stage_runs WHERE session_id = ? ORDER BY started_at DESC")
    .all(sessionId) as StageRunRow[];
}

// --- agent runs ------------------------------------------------------------

export function startAgentRun(
  db: Db,
  run: {
    session_id: string | null;
    provider: string;
    model?: string | null;
    purpose?: string | null;
    prompt?: string | null;
    permission_mode?: string | null;
    transcript_path?: string | null;
  },
): string {
  const id = newId("arun");
  db.prepare(
    `INSERT INTO agent_runs
       (agent_run_id, session_id, provider, model, purpose, prompt, permission_mode, status, transcript_path, created_at, started_at)
     VALUES (@agent_run_id, @session_id, @provider, @model, @purpose, @prompt, @permission_mode, 'running', @transcript_path, @created_at, @created_at)`,
  ).run({
    agent_run_id: id,
    session_id: run.session_id,
    provider: run.provider,
    model: run.model ?? null,
    purpose: run.purpose ?? null,
    prompt: run.prompt ?? null,
    permission_mode: run.permission_mode ?? null,
    transcript_path: run.transcript_path ?? null,
    created_at: now(),
  });
  return id;
}

export function finishAgentRun(
  db: Db,
  id: string,
  outcome: {
    status: string;
    result_text?: string | null;
    error?: string | null;
    num_turns?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_cost_usd?: number | null;
    duration_ms?: number | null;
  },
): void {
  db.prepare(
    `UPDATE agent_runs SET
       status = @status, result_text = @result_text, error = @error,
       num_turns = @num_turns, input_tokens = @input_tokens, output_tokens = @output_tokens,
       total_cost_usd = @total_cost_usd, duration_ms = @duration_ms, finished_at = @finished_at
     WHERE agent_run_id = @agent_run_id`,
  ).run({
    agent_run_id: id,
    status: outcome.status,
    result_text: outcome.result_text ?? null,
    error: outcome.error ?? null,
    num_turns: outcome.num_turns ?? null,
    input_tokens: outcome.input_tokens ?? null,
    output_tokens: outcome.output_tokens ?? null,
    total_cost_usd: outcome.total_cost_usd ?? null,
    duration_ms: outcome.duration_ms ?? null,
    finished_at: now(),
  });
}

export function listAgentRuns(db: Db, sessionId?: string): AgentRunRow[] {
  return sessionId === undefined
    ? (db.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC").all() as AgentRunRow[])
    : (db
        .prepare("SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC")
        .all(sessionId) as AgentRunRow[]);
}

// --- flags -----------------------------------------------------------------

/**
 * Idempotent: re-running a stage re-reports the same flags, and the review UI
 * must not sprout duplicates. A flag already resolved stays resolved — the
 * unique index carries the identity, so re-running never undoes a decision.
 */
export function upsertFlag(
  db: Db,
  flag: {
    session_id: string;
    stage: string;
    code: string;
    reason: string;
    severity?: string;
    utterance_id?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO flags (flag_id, session_id, stage, utterance_id, code, reason, severity, status, created_at)
     VALUES (@flag_id, @session_id, @stage, @utterance_id, @code, @reason, @severity, 'open', @created_at)
     ON CONFLICT (session_id, stage, code, COALESCE(utterance_id, '')) DO UPDATE SET
       reason = excluded.reason,
       severity = excluded.severity`,
  ).run({
    flag_id: newId("flag"),
    session_id: flag.session_id,
    stage: flag.stage,
    utterance_id: flag.utterance_id ?? null,
    code: flag.code,
    reason: flag.reason,
    severity: flag.severity ?? "warning",
    created_at: now(),
  });
}

export function resolveFlag(
  db: Db,
  flagId: string,
  resolution: { status: "resolved" | "dismissed"; resolution?: string; resolved_by: string },
): void {
  db.prepare(
    `UPDATE flags SET status = @status, resolution = @resolution, resolved_by = @resolved_by, resolved_at = @resolved_at
     WHERE flag_id = @flag_id`,
  ).run({
    flag_id: flagId,
    status: resolution.status,
    resolution: resolution.resolution ?? null,
    resolved_by: resolution.resolved_by,
    resolved_at: now(),
  });
}

export function listFlags(db: Db, sessionId: string, options: { status?: string } = {}): FlagRow[] {
  return options.status === undefined
    ? (db
        .prepare("SELECT * FROM flags WHERE session_id = ? ORDER BY code, utterance_id")
        .all(sessionId) as FlagRow[])
    : (db
        .prepare(
          "SELECT * FROM flags WHERE session_id = ? AND status = ? ORDER BY code, utterance_id",
        )
        .all(sessionId, options.status) as FlagRow[]);
}

export function countFlagsByCode(db: Db, sessionId: string): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT code, COUNT(*) AS n FROM flags WHERE session_id = ? AND status = 'open' GROUP BY code",
    )
    .all(sessionId) as Array<{ code: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.code, row.n]));
}

/** Clears a stage's flags before it re-reports them, preserving resolutions. */
export function clearOpenFlags(db: Db, sessionId: string, stage: string): number {
  return db
    .prepare("DELETE FROM flags WHERE session_id = ? AND stage = ? AND status = 'open'")
    .run(sessionId, stage).changes;
}

// --- settings --------------------------------------------------------------

/**
 * Never store a credential here. Providers get an env var name or a keychain
 * reference; the value itself stays out of the database.
 */
export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function allSettings(db: Db): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
