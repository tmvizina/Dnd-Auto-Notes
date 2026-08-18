import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb, resolveOrphanedRuns, schemaVersion } from "./db.js";
import type { Db } from "./db.js";
import { ID_PATTERN, newId } from "./ids.js";
import {
  finishAgentRun,
  getSetting,
  listAgentRuns,
  listSessions,
  listStageRuns,
  recordStageRun,
  setSetting,
  startAgentRun,
  upsertSession,
} from "./records.js";
import { SCHEMA_VERSION } from "./schema.js";

let dir: string;
let dbPath: string;
let db: Db;

const SESSION = {
  session_id: "2026-08-16-fixture",
  title: "Fixture",
  number: 42,
  date: "2026-08-16",
  root_path: "/sessions/2026-08-16-fixture",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dnd-db-"));
  dbPath = join(dir, "data", "notes.db");
  db = openDb(dbPath);
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("opening", () => {
  it("creates the schema and records its version", () => {
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(listSessions(db)).toEqual([]);
  });

  it("is a no-op on an existing database, preserving data", () => {
    upsertSession(db, SESSION);
    closeDb(db);

    db = openDb(dbPath);
    expect(listSessions(db)).toHaveLength(1);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("turns on WAL and foreign keys, not just claims to", () => {
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("enforces foreign keys — a run cannot outlive its session", () => {
    upsertSession(db, SESSION);
    recordStageRun(db, {
      session_id: SESSION.session_id,
      stage: "intake",
      version: 1,
      status: "ok",
      started_at: new Date().toISOString(),
    });
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(SESSION.session_id);
    expect(listStageRuns(db, SESSION.session_id)).toEqual([]);
  });

  it("rejects a stage run for a session that does not exist", () => {
    expect(() =>
      recordStageRun(db, {
        session_id: "no-such-session",
        stage: "intake",
        version: 1,
        status: "ok",
        started_at: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe("ids", () => {
  it("are prefixed and identifiable on sight", () => {
    expect(newId("srun")).toMatch(ID_PATTERN);
    expect(newId("arun").startsWith("arun_")).toBe(true);
  });

  it("do not collide across many draws", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("x")));
    expect(ids.size).toBe(2000);
  });
});

describe("sessions", () => {
  it("upserts rather than duplicating", () => {
    upsertSession(db, SESSION);
    upsertSession(db, { ...SESSION, title: "Renamed", grade: "B" });

    const rows = listSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Renamed");
    expect(rows[0]?.grade).toBe("B");
  });
});

describe("agent runs", () => {
  it("records a run from start to finish", () => {
    upsertSession(db, SESSION);
    const id = startAgentRun(db, {
      session_id: SESSION.session_id,
      provider: "cli-claude",
      model: "claude-sonnet-5",
      purpose: "adjudicate",
    });
    finishAgentRun(db, id, {
      status: "ok",
      result_text: "done",
      num_turns: 3,
      input_tokens: 1200,
      output_tokens: 300,
      total_cost_usd: 0.01,
    });

    const [row] = listAgentRuns(db, SESSION.session_id);
    expect(row?.status).toBe("ok");
    expect(row?.num_turns).toBe(3);
    expect(row?.finished_at).not.toBeNull();
  });

  it("survives its session being deleted, rather than vanishing", () => {
    upsertSession(db, SESSION);
    startAgentRun(db, { session_id: SESSION.session_id, provider: "cli-codex" });
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(SESSION.session_id);

    const rows = listAgentRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBeNull();
  });
});

describe("orphaned runs", () => {
  it("resolves anything still claiming to run after a crash", () => {
    upsertSession(db, SESSION);
    recordStageRun(db, {
      session_id: SESSION.session_id,
      stage: "transcript",
      version: 1,
      status: "running",
      started_at: new Date().toISOString(),
    });
    startAgentRun(db, { session_id: SESSION.session_id, provider: "cli-claude" });

    expect(resolveOrphanedRuns(db)).toEqual({ stageRuns: 1, agentRuns: 1 });
    expect(listStageRuns(db, SESSION.session_id)[0]?.status).toBe("interrupted");
    expect(listAgentRuns(db)[0]?.status).toBe("interrupted");
  });

  it("leaves finished runs alone", () => {
    upsertSession(db, SESSION);
    recordStageRun(db, {
      session_id: SESSION.session_id,
      stage: "intake",
      version: 1,
      status: "ok",
      started_at: new Date().toISOString(),
    });
    expect(resolveOrphanedRuns(db).stageRuns).toBe(0);
  });
});

describe("settings", () => {
  it("round-trips and overwrites by key", () => {
    setSetting(db, "provider", "cli-claude");
    expect(getSetting(db, "provider")).toBe("cli-claude");
    setSetting(db, "provider", "http-local");
    expect(getSetting(db, "provider")).toBe("http-local");
  });

  it("returns undefined for an unset key rather than throwing", () => {
    expect(getSetting(db, "nope")).toBeUndefined();
  });
});
