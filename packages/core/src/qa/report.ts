import { countBySeverity, hasErrors } from "../contracts/qa.js";
import type { QaReport } from "../contracts/qa.js";
import { checkIntakeQa } from "./checks.js";
import type { IntakeQaChecksInput } from "./checks.js";

export interface IntakeQaReportOptions extends IntakeQaChecksInput {
  /** Allows a future caller to label a compatible report without changing checks. */
  readonly stage?: string;
}

/** Build the validated shape written to `work/01-intake/qa.json`. */
export function buildIntakeQaReport(input: IntakeQaReportOptions): QaReport {
  const entries = checkIntakeQa(input);
  const counts = countBySeverity({ stage: "intake", entries, metrics: {} });
  return {
    stage: input.stage ?? "intake",
    entries,
    metrics: {
      entries: entries.length,
      errors: counts.error,
      warnings: counts.warning,
      infos: counts.info,
    },
  };
}

export const makeIntakeQaReport = buildIntakeQaReport;

/** The CLI contract: warnings and informational entries do not fail a run. */
export function qaExitCode(report: QaReport): 0 | 2 {
  return hasErrors(report) ? 2 : 0;
}

export function hasQaErrors(report: QaReport): boolean {
  return hasErrors(report);
}

export function isCleanQa(report: QaReport): boolean {
  return report.entries.length === 0;
}
