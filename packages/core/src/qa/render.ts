import { countBySeverity } from "../contracts/qa.js";
import type { QaReport } from "../contracts/qa.js";

function cell(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\|/g, "/")
    .trim();
}

function row(values: readonly string[], widths: readonly number[]): string {
  return `| ${values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join(" | ")} |`;
}

function separator(widths: readonly number[]): string {
  return `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
}

/**
 * Render a stable, copy/paste-friendly table. Entries are already sorted by
 * the checker; no timestamps, object identity, or terminal width affect it.
 */
export function renderQaTable(report: QaReport): string {
  const header = ["severity", "code", "subject", "message", "hint"];
  const values = report.entries.map((entry) => [
    entry.severity,
    entry.code,
    entry.subject ?? "",
    entry.message,
    entry.hint ?? "",
  ]);
  const widths = header.map((name, index) =>
    Math.max(name.length, ...values.map((value) => cell(value[index]).length)),
  );
  const lines = [`QA ${report.stage}`, row(header, widths), separator(widths)];
  for (const valuesForEntry of values) {
    lines.push(row(valuesForEntry.map(cell), widths));
  }
  const counts = countBySeverity(report);
  lines.push(
    `summary: ${String(counts.error)} error(s), ${String(counts.warning)} warning(s), ${String(counts.info)} info`,
  );
  return `${lines.join("\n")}\n`;
}

/** Canonical JSON used by CLI NDJSON consumers and human-readable artifacts. */
export function serializeQaReport(report: QaReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export const renderQaTerminal = renderQaTable;
export const renderQaJson = serializeQaReport;
