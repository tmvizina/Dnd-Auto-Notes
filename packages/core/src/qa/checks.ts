import type { QaEntry } from "../contracts/common.js";
import type { Manifest, Track } from "../contracts/manifest.js";
import { isSilent } from "../intake/craig/speech.js";
import {
  hintForIntakeQa,
  INTAKE_QA_CODES,
  intakeQaDefinition,
  isIntakeQaCode,
  qaHintPaths,
} from "./catalog.js";
import type { IntakeQaCode, QaHintPaths } from "./catalog.js";

/** The small registry surface QA needs; a full campaign registry is accepted. */
export interface QaPlayer {
  readonly id: string;
  readonly display_name: string;
  readonly is_dm?: boolean;
}

export interface QaRegistry {
  readonly players: readonly QaPlayer[];
}

export interface IntakeQaChecksInput {
  readonly manifest: Manifest;
  /** Omit when no identity registry was loaded; no player check is invented. */
  readonly registry?: QaRegistry;
  /** Explicit session membership avoids guessing from campaign history. */
  readonly activePlayerIds?: readonly string[];
  readonly alignmentToleranceS?: number;
  readonly hintPaths?: Partial<QaHintPaths>;
}

const DEFAULT_ALIGNMENT_TOLERANCE_S = 2;

interface CandidateEntry {
  readonly entry: QaEntry;
  readonly order: number;
}

function severityOrder(severity: QaEntry["severity"]): number {
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function codeOrder(code: string): number {
  const index = INTAKE_QA_CODES.indexOf(code as IntakeQaCode);
  return index < 0 ? INTAKE_QA_CODES.length : index;
}

function cleanText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function subjectOf(entry: QaEntry): string | undefined {
  const subject = entry.subject?.trim();
  return subject === undefined || subject === "" ? undefined : subject;
}

function makeEntry(
  code: IntakeQaCode,
  message: string,
  subject: string | undefined,
  paths: Partial<QaHintPaths>,
): QaEntry {
  const definition = intakeQaDefinition(code);
  if (definition === undefined) {
    throw new Error(`unknown intake QA code: ${code}`);
  }
  return {
    code,
    severity: definition.severity,
    message: cleanText(message),
    ...(subject === undefined ? {} : { subject: cleanText(subject) }),
    hint: hintForIntakeQa(code, subject, paths),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function accountForRoll(roll: Manifest["rolls"][number]): string {
  return roll.who?.trim() || roll.roll20_player_id?.trim() || "(unknown account)";
}

function trackDurationEntries(
  tracks: readonly Track[],
  tolerance: number,
  paths: Partial<QaHintPaths>,
): QaEntry[] {
  if (tracks.length === 0) return [];
  const reference = median(tracks.map((track) => track.duration_s));
  const outliers = tracks.filter(
    (track) => !track.aligned || Math.abs(track.duration_s - reference) > tolerance,
  );
  if (outliers.length === 0) return [];
  return [
    makeEntry(
      "TRACK_DURATION_MISMATCH",
      `${String(outliers.length)} track(s) disagree with the ${reference.toFixed(2)}s median by more than ${tolerance.toFixed(1)}s: ${outliers
        .map((track) => `${track.track_id} (${track.duration_s.toFixed(2)}s)`)
        .join(", ")}`,
      outliers.map((track) => track.track_id).join(","),
      paths,
    ),
  ];
}

function normalizeEntry(entry: QaEntry, paths: Partial<QaHintPaths>): QaEntry {
  const subject = subjectOf(entry);
  if (isIntakeQaCode(entry.code)) {
    const definition = intakeQaDefinition(entry.code);
    return {
      code: entry.code,
      severity: definition?.severity ?? entry.severity,
      message: cleanText(entry.message),
      ...(subject === undefined ? {} : { subject }),
      hint: hintForIntakeQa(entry.code, subject, paths),
    };
  }

  // Unknown codes are retained so a newer producer cannot silently lose an
  // evidence record. The fallback still names the artifact and field to edit.
  const existingHint = entry.hint === undefined ? "" : cleanText(entry.hint);
  const fallback = hintForIntakeQa(entry.code, subject, paths);
  return {
    code: cleanText(entry.code),
    severity: entry.severity,
    message: cleanText(entry.message),
    ...(subject === undefined ? {} : { subject }),
    hint: existingHint === "" ? fallback : `${existingHint}; ${fallback}`,
  };
}

function sortAndDedupe(entries: readonly CandidateEntry[]): QaEntry[] {
  const sorted = [...entries].sort((left, right) => {
    const a = left.entry;
    const b = right.entry;
    return (
      severityOrder(a.severity) - severityOrder(b.severity) ||
      codeOrder(a.code) - codeOrder(b.code) ||
      a.code.localeCompare(b.code) ||
      (a.subject ?? "").localeCompare(b.subject ?? "") ||
      a.message.localeCompare(b.message) ||
      left.order - right.order
    );
  });

  const seen = new Set<string>();
  const result: QaEntry[] = [];
  for (const item of sorted) {
    // Intake's stage-level checks use subject as their stable identity. This
    // removes the duplicate that would otherwise arise when a producer has
    // already emitted the same evidence into manifest.qa.
    const key = `${item.entry.code}\u0000${item.entry.subject ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item.entry);
  }
  return result;
}

/**
 * Run deterministic intake checks over the manifest and optional registry.
 * Existing producer entries are preserved and normalized; checks only derive
 * facts represented by manifest fields or explicit session membership input.
 */
export function checkIntakeQa(input: IntakeQaChecksInput): QaEntry[] {
  const { manifest } = input;
  const paths = qaHintPaths(input.hintPaths);
  const tolerance = input.alignmentToleranceS ?? DEFAULT_ALIGNMENT_TOLERANCE_S;
  const entries: CandidateEntry[] = [];
  let order = 0;
  const producerCodes = new Set(manifest.qa.map((entry) => entry.code));
  const alreadyReported = (code: IntakeQaCode): boolean => producerCodes.has(code);

  const add = (entry: QaEntry): void => {
    entries.push({ entry: normalizeEntry(entry, paths), order });
    order += 1;
  };

  for (const entry of manifest.qa) add(entry);

  if (!alreadyReported("TRACK_UNMAPPED")) {
    for (const track of manifest.tracks) {
      if (track.player_id !== null) continue;
      add(
        makeEntry(
          "TRACK_UNMAPPED",
          `${track.track_id} (${track.path}) has no player mapping; no candidate decision was retained`,
          track.track_id,
          paths,
        ),
      );
    }
  }

  const unmappedRolls = new Map<string, number>();
  for (const roll of manifest.rolls) {
    if (roll.player_id !== null) continue;
    const account = accountForRoll(roll);
    unmappedRolls.set(account, (unmappedRolls.get(account) ?? 0) + 1);
  }
  if (!alreadyReported("ROLL20_ACCOUNT_UNMAPPED")) {
    for (const [account, count] of [...unmappedRolls.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      add(
        makeEntry(
          "ROLL20_ACCOUNT_UNMAPPED",
          `${String(count)} Roll20 roll${count === 1 ? "" : "s"} by "${account}" has no mapped player_id`,
          account,
          paths,
        ),
      );
    }
  }

  // A campaign registry is long-lived, while a session roster is not part of
  // the intake manifest. Only an explicit roster can justify this warning.
  if (input.registry !== undefined && input.activePlayerIds !== undefined) {
    const trackPlayers = new Set(
      manifest.tracks.flatMap((track) => (track.player_id === null ? [] : [track.player_id])),
    );
    const activeIds = [...input.activePlayerIds];
    const byId = new Map(input.registry.players.map((player) => [player.id, player]));
    for (const playerId of [...new Set(activeIds)].sort((a, b) => a.localeCompare(b))) {
      if (trackPlayers.has(playerId)) continue;
      const player = byId.get(playerId);
      const name = player?.display_name ?? playerId;
      add(
        makeEntry(
          "PLAYER_NO_TRACK",
          `${name} (${playerId}) is active in this session but has no Craig track`,
          playerId,
          paths,
        ),
      );
    }
  }

  if (!alreadyReported("TRACK_SILENT")) {
    for (const track of manifest.tracks) {
      if (!isSilent(track.speech_ratio)) continue;
      add(
        makeEntry(
          "TRACK_SILENT",
          `${track.track_id} carries almost no speech (speech_ratio ${track.speech_ratio.toFixed(4)})`,
          track.track_id,
          paths,
        ),
      );
    }
  }

  if (!alreadyReported("TRACK_DURATION_MISMATCH")) {
    for (const entry of trackDurationEntries(manifest.tracks, tolerance, paths)) add(entry);
  }

  if (manifest.tracks.length === 0 && !alreadyReported("CRAIG_NO_TRACKS")) {
    add(
      makeEntry(
        "CRAIG_NO_TRACKS",
        "no audio tracks found in the Craig input",
        "input/craig",
        paths,
      ),
    );
  }

  if (manifest.roll20 === null && !alreadyReported("ROLL20_NO_CAPTURE")) {
    add(makeEntry("ROLL20_NO_CAPTURE", "no Roll20 capture was found", paths.roll20Input, paths));
  } else if (
    manifest.roll20 !== null &&
    manifest.roll20.time_basis === "order_only" &&
    !alreadyReported("TIME_BASIS_ORDER_ONLY")
  ) {
    add(
      makeEntry(
        "TIME_BASIS_ORDER_ONLY",
        "Roll20 absolute time was not trusted; capture order remains available for alignment",
        manifest.roll20.path,
        paths,
      ),
    );
  }

  return sortAndDedupe(entries);
}

/** Alias used by callers that treat checks as a report-producing operation. */
export const runIntakeChecks = checkIntakeQa;
