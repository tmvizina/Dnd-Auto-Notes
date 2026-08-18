import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import { runStage } from "../stage/runner.js";
import { MINIMAL } from "../testing/fixtures.js";
import { closeDb, openDb } from "./db.js";
import type { Db } from "./db.js";
import { listSessions, listStageRuns, upsertSession } from "./records.js";
import { reindexAll, reindexSession } from "./reindex.js";

let dir: string;
let sessionsRoot: string;
let db: Db;
let session: Session;

/** Drops the id and timestamps that legitimately differ between rebuilds. */
function comparable(rows: ReturnType<typeof listStageRuns>) {
  return rows
    .map((row) => ({
      stage: row.stage,
      version: row.version,
      status: row.status,
      params_hash: row.params_hash,
      started_at: row.started_at,
      finished_at: row.finished_at,
    }))
    .sort((a, b) => a.stage.localeCompare(b.stage));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dnd-reindex-"));
  sessionsRoot = join(dir, "sessions");
  db = openDb(join(dir, "notes.db"));
  session = await createSession(sessionsRoot, { title: "Reindex", date: "2026-08-16" });

  await runStage(
    {
      session,
      stage: "intake",
      version: 1,
      output: "manifest",
      inputs: [],
      params: { craig: true },
    },
    async () => {
      await writeArtifact(session, "manifest", MINIMAL.manifest);
    },
  );
  await runStage(
    { session, stage: "transcript", version: 2, output: "transcript", inputs: [] },
    async () => {
      await writeArtifact(session, "transcript", MINIMAL.transcript);
    },
  );
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("reindexSession", () => {
  it("rebuilds the session and its stage history from disk alone", async () => {
    expect(await reindexSession(db, session.paths.root)).toBe(true);

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session_id).toBe(session.descriptor.id);
    expect(sessions[0]?.title).toBe("Reindex");

    const runs = listStageRuns(db, session.descriptor.id);
    expect(runs.map((r) => r.stage).sort()).toEqual(["intake", "transcript"]);
    expect(runs.find((r) => r.stage === "transcript")?.version).toBe(2);
  });

  it("produces identical rows after the database is deleted entirely", async () => {
    await reindexSession(db, session.paths.root);
    const before = comparable(listStageRuns(db, session.descriptor.id));
    closeDb(db);
    rmSync(join(dir, "notes.db"), { force: true });

    // The session folder is the source of truth. If a rebuild ever differed,
    // the database was holding a fact that lived nowhere else.
    db = openDb(join(dir, "notes.db"));
    await reindexSession(db, session.paths.root);

    expect(comparable(listStageRuns(db, session.descriptor.id))).toEqual(before);
  });

  it("is idempotent — reindexing twice does not double the history", async () => {
    await reindexSession(db, session.paths.root);
    await reindexSession(db, session.paths.root);
    expect(listStageRuns(db, session.descriptor.id)).toHaveLength(2);
    expect(listSessions(db)).toHaveLength(1);
  });

  it("replaces stale stage rows rather than merging them", async () => {
    upsertSession(db, {
      session_id: session.descriptor.id,
      title: "Reindex",
      number: null,
      date: "2026-08-16",
      root_path: session.paths.root,
    });
    // A stage that no longer has a _stage.json on disk must not survive.
    db.prepare(
      `INSERT INTO stage_runs (stage_run_id, session_id, stage, version, status, skipped, started_at)
       VALUES ('srun_stale', ?, 'ghost', 1, 'ok', 0, '2020-01-01T00:00:00.000Z')`,
    ).run(session.descriptor.id);

    await reindexSession(db, session.paths.root);
    expect(listStageRuns(db, session.descriptor.id).map((r) => r.stage)).not.toContain("ghost");
  });

  it("returns false for a directory that is not a session", async () => {
    expect(await reindexSession(db, join(dir, "nowhere"))).toBe(false);
    expect(listSessions(db)).toEqual([]);
  });

  it("reindexes every session under a root", async () => {
    await createSession(sessionsRoot, { title: "Second", date: "2026-09-01" });
    expect(await reindexAll(db, sessionsRoot)).toBe(2);
    expect(listSessions(db)).toHaveLength(2);
  });
});

describe("concurrent access", () => {
  it("serves a read while another connection holds a write open", async () => {
    await reindexSession(db, session.paths.root);

    const reader = openDb(join(dir, "notes.db"));
    const write = db.transaction(() => {
      db.prepare("UPDATE sessions SET title = ? WHERE session_id = ?").run(
        "mid-write",
        session.descriptor.id,
      );
      // WAL is what makes this readable rather than a SQLITE_BUSY.
      expect(listSessions(reader)).toHaveLength(1);
    });
    write();

    expect(listSessions(reader)[0]?.title).toBe("mid-write");
    closeDb(reader);
  });
});
