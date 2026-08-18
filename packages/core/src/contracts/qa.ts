import { z } from "zod";
import { QaEntry } from "./common.js";

/**
 * The report that says how much of the session the pipeline actually
 * understood. Notes look equally confident either way; this is the only thing
 * that tells the difference.
 */

export const QaGrade = z.enum(["A", "B", "C", "D"]);
export type QaGrade = z.infer<typeof QaGrade>;

export const QaReport = z.object({
  stage: z.string(),
  entries: z.array(QaEntry).default([]),
  metrics: z.record(z.string(), z.number()).default({}),
  grade: QaGrade.optional(),
  /** The rule that produced the grade, spelled out. No opaque scores. */
  grade_rule: z.string().optional(),
});
export type QaReport = z.infer<typeof QaReport>;

export function countBySeverity(report: QaReport): Record<"error" | "warning" | "info", number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of report.entries) counts[entry.severity] += 1;
  return counts;
}

export function hasErrors(report: QaReport): boolean {
  return report.entries.some((entry) => entry.severity === "error");
}
