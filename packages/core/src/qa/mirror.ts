import type { QaEntry } from "../contracts/common.js";
import type { QaReport } from "../contracts/qa.js";
import type { Db } from "../db/db.js";
import { clearOpenFlags, upsertFlag } from "../db/records.js";

export interface QaFlagInput {
  readonly session_id: string;
  readonly stage: string;
  readonly code: string;
  readonly reason: string;
  readonly severity: QaEntry["severity"];
  /** The flags schema has no generic subject column; this preserves identity. */
  readonly utterance_id: string | null;
}

/** Convert a report to the rows the desktop review index should see. */
export function qaFlagsForReport(
  sessionId: string,
  report: QaReport,
  stage = report.stage,
): QaFlagInput[] {
  return report.entries.map((entry) => ({
    session_id: sessionId,
    stage,
    code: entry.code,
    reason: entry.message,
    severity: entry.severity,
    // Intake subjects are track ids, player ids, account names, or source
    // paths. The existing nullable identity slot keeps repeated track/account
    // findings distinct without adding a second database schema in P1-10.
    utterance_id: entry.subject ?? null,
  }));
}

/**
 * Replace open intake flags while leaving human resolutions untouched. The
 * database remains a mirror: the report on disk is still the source of truth.
 */
export function mirrorQaFlags(
  db: Db,
  sessionId: string,
  report: QaReport,
  stage = report.stage,
): number {
  const rows = qaFlagsForReport(sessionId, report, stage);
  const apply = db.transaction(() => {
    clearOpenFlags(db, sessionId, stage);
    for (const row of rows) upsertFlag(db, row);
  });
  apply();
  return rows.length;
}

export const mirrorOpenQaFlags = mirrorQaFlags;
