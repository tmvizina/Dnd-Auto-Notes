import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb } from "./db.js";
import type { Db } from "./db.js";
import {
  clearOpenFlags,
  countFlagsByCode,
  listFlags,
  resolveFlag,
  upsertFlag,
  upsertSession,
} from "./records.js";

let dir: string;
let db: Db;

const SESSION_ID = "2026-08-16-fixture";
const flag = {
  session_id: SESSION_ID,
  stage: "persona",
  code: "persona_ambiguous",
  reason: "voice margin below threshold",
  utterance_id: "u000412",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dnd-flags-"));
  db = openDb(join(dir, "notes.db"));
  upsertSession(db, {
    session_id: SESSION_ID,
    title: "Fixture",
    number: 42,
    date: "2026-08-16",
    root_path: "/sessions/x",
  });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("flags", () => {
  it("does not duplicate when a stage re-runs", () => {
    upsertFlag(db, flag);
    upsertFlag(db, { ...flag, reason: "updated reason" });

    const rows = listFlags(db, SESSION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("updated reason");
  });

  it("keeps a resolution when the stage re-reports the same flag", () => {
    upsertFlag(db, flag);
    const [row] = listFlags(db, SESSION_ID);
    resolveFlag(db, row!.flag_id, {
      status: "resolved",
      resolution: "ch_seren",
      resolved_by: "ash",
    });

    // Re-running persona must not undo a human's decision.
    upsertFlag(db, flag);

    const [after] = listFlags(db, SESSION_ID);
    expect(after?.status).toBe("resolved");
    expect(after?.resolution).toBe("ch_seren");
  });

  it("clears open flags for a stage without touching resolved ones", () => {
    upsertFlag(db, flag);
    upsertFlag(db, { ...flag, utterance_id: "u000413" });
    const [first] = listFlags(db, SESSION_ID);
    resolveFlag(db, first!.flag_id, { status: "resolved", resolved_by: "ash" });

    expect(clearOpenFlags(db, SESSION_ID, "persona")).toBe(1);
    const remaining = listFlags(db, SESSION_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.status).toBe("resolved");
  });

  it("counts open flags by code", () => {
    upsertFlag(db, flag);
    upsertFlag(db, { ...flag, utterance_id: "u2" });
    upsertFlag(db, { ...flag, code: "unknown_npc", utterance_id: "u3" });
    expect(countFlagsByCode(db, SESSION_ID)).toEqual({
      persona_ambiguous: 2,
      unknown_npc: 1,
    });
  });

  it("distinguishes two session-level flags that differ only by code", () => {
    upsertFlag(db, { ...flag, utterance_id: null, code: "TRACK_UNMAPPED" });
    upsertFlag(db, { ...flag, utterance_id: null, code: "TRACK_SILENT" });
    expect(listFlags(db, SESSION_ID, { status: "open" })).toHaveLength(2);
  });

  it("treats the same session-level flag twice as one", () => {
    upsertFlag(db, { ...flag, utterance_id: null, code: "TRACK_UNMAPPED" });
    upsertFlag(db, { ...flag, utterance_id: null, code: "TRACK_UNMAPPED" });
    expect(listFlags(db, SESSION_ID, { status: "open" })).toHaveLength(1);
  });
});
