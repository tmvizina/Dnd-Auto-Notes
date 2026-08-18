import { QaReport } from "../contracts/qa.js";
import { readArtifact, writeArtifact } from "../session/session.js";
import type { Session } from "../session/session.js";
import type { FileIo } from "../session/io.js";

/** The artifact name is kept in one place for callers and tests. */
export const INTAKE_QA_ARTIFACT = "intakeQa" as const;

export function intakeQaArtifactPath(session: Session): string {
  return session.paths.artifact(INTAKE_QA_ARTIFACT);
}

/** Validate then atomically write `work/01-intake/qa.json`. */
export async function writeIntakeQaReport(
  session: Session,
  report: QaReport,
  io?: FileIo,
): Promise<QaReport> {
  const parsed = QaReport.parse(report);
  return writeArtifact(session, INTAKE_QA_ARTIFACT, parsed, io);
}

export async function readIntakeQaReport(session: Session): Promise<QaReport> {
  return readArtifact(session, INTAKE_QA_ARTIFACT);
}

/** Alias for stage implementations that call artifact persistence generically. */
export const persistIntakeQa = writeIntakeQaReport;
