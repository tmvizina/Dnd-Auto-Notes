import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS, STAGE_META_FILENAME } from "../contracts/artifacts.js";
import { StageMeta } from "../contracts/stageMeta.js";
import { SessionDescriptor } from "../session/session.js";
import type { Db } from "./db.js";
import { recordStageRun, upsertSession } from "./records.js";

/**
 * Rebuilds every row for a session from the files on disk.
 *
 * This is what makes the database disposable: the session folder is the source
 * of truth, and deleting the database costs nothing but the time to run this.
 * If a rebuild ever produces different rows, the database was holding a fact
 * that lived nowhere else — which is the bug.
 */
export async function reindexSession(db: Db, sessionRoot: string): Promise<boolean> {
  const descriptorPath = join(sessionRoot, ARTIFACTS.session);
  if (!existsSync(descriptorPath)) return false;

  const parsed = SessionDescriptor.safeParse(
    JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
  );
  if (!parsed.success) return false;
  const descriptor = parsed.data;

  db.transaction(() => {
    upsertSession(db, {
      session_id: descriptor.id,
      title: descriptor.title,
      number: descriptor.number,
      date: descriptor.date,
      root_path: sessionRoot,
    });
    // Stage history is derived, so it is replaced wholesale rather than merged:
    // a stale row for a stage that has since been re-run would be a lie.
    db.prepare("DELETE FROM stage_runs WHERE session_id = ?").run(descriptor.id);
  })();

  for (const meta of await readStageMetas(sessionRoot)) {
    recordStageRun(db, {
      session_id: descriptor.id,
      stage: meta.stage,
      version: meta.version,
      status: meta.status,
      skipped: meta.status === "skipped",
      params_hash: meta.params_hash,
      error: meta.error ?? null,
      started_at: meta.started_at,
      finished_at: meta.finished_at,
      duration_s: meta.duration_s,
    });
  }
  return true;
}

async function readStageMetas(sessionRoot: string): Promise<StageMeta[]> {
  const workDir = join(sessionRoot, "work");
  if (!existsSync(workDir)) return [];

  const metas: StageMeta[] = [];
  for (const entry of await readdir(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(workDir, entry.name, STAGE_META_FILENAME);
    if (!existsSync(metaPath)) continue;
    try {
      const parsed = StageMeta.safeParse(JSON.parse(await readFile(metaPath, "utf8")) as unknown);
      if (parsed.success) metas.push(parsed.data);
    } catch {
      // An unreadable meta means that stage simply has no history to index.
      // Refusing to reindex the whole session over one bad file would be worse.
    }
  }
  return metas.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Rebuilds every session under a sessions root. */
export async function reindexAll(db: Db, sessionsRoot: string): Promise<number> {
  if (!existsSync(sessionsRoot)) return 0;
  let count = 0;
  for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (await reindexSession(db, join(sessionsRoot, entry.name))) count += 1;
  }
  return count;
}
