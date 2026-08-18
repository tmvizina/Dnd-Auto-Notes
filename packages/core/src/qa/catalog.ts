import type { QaEntry } from "../contracts/common.js";

/**
 * The paths used in hints are contract paths, not machine-specific absolute
 * paths. Keeping them here makes terminal output and qa.json stable on every
 * platform while still telling a human exactly where to make the repair.
 */
export interface QaHintPaths {
  readonly playersFile: string;
  readonly manifestFile: string;
  readonly craigInput: string;
  readonly roll20Input: string;
}

export const DEFAULT_QA_HINT_PATHS: QaHintPaths = Object.freeze({
  playersFile: "campaign/players.json",
  manifestFile: "work/01-intake/manifest.json",
  craigInput: "input/craig",
  roll20Input: "input/roll20",
});

/**
 * One stable definition for every code currently emitted by intake. The
 * producing stages may add useful evidence to a message, but they must not
 * silently change a code's severity or meaning.
 */
export interface IntakeQaCodeDefinition {
  readonly severity: QaEntry["severity"];
  readonly summary: string;
}

export const INTAKE_QA_CATALOG = Object.freeze({
  TRACK_UNMAPPED: {
    severity: "error",
    summary: "a Craig track has no player mapping",
  },
  ROLL20_ACCOUNT_UNMAPPED: {
    severity: "error",
    summary: "a Roll20 account has no player mapping",
  },
  PLAYER_NO_TRACK: {
    severity: "warning",
    summary: "an active player has no Craig track",
  },
  TRACK_SILENT: {
    severity: "warning",
    summary: "a Craig track contains almost no speech",
  },
  TRACK_DURATION_MISMATCH: {
    severity: "error",
    summary: "a Craig track falls outside the shared recording duration",
  },
  ROLL20_WINDOW_MISMATCH: {
    severity: "warning",
    summary: "a Roll20 event is outside the Craig recording window",
  },
  TIME_BASIS_ORDER_ONLY: {
    severity: "info",
    summary: "Roll20 order is known but no absolute time was trusted",
  },
  ROLL20_UNPARSED_MESSAGES: {
    severity: "warning",
    summary: "one or more Roll20 messages could not be parsed",
  },
  CRAIG_ARCHIVE_EXTRACTED: {
    severity: "info",
    summary: "a Craig archive was extracted for intake",
  },
  CRAIG_NO_TRACKS: {
    severity: "error",
    summary: "the Craig input contains no audio tracks",
  },
  TRACK_NAME_UNPARSED: {
    severity: "warning",
    summary: "a Craig filename does not follow the expected convention",
  },
  ROLL20_MESSAGEID_NON_MONOTONIC: {
    severity: "warning",
    summary: "decoded Roll20 message ids move backwards",
  },
  ROLL20_NO_CAPTURE: {
    severity: "error",
    summary: "no Roll20 capture was found",
  },
} as const satisfies Record<string, IntakeQaCodeDefinition>);

export type IntakeQaCode = keyof typeof INTAKE_QA_CATALOG;

/** Alias kept short for callers that want to display the catalog. */
export const QA_CODE_CATALOG = INTAKE_QA_CATALOG;
export const INTAKE_QA_CODES = Object.freeze(Object.keys(INTAKE_QA_CATALOG) as IntakeQaCode[]);

const pathText = (value: string): string => value.replaceAll("\\", "/");

export function qaHintPaths(paths: Partial<QaHintPaths> = {}): QaHintPaths {
  return {
    playersFile: pathText(paths.playersFile ?? DEFAULT_QA_HINT_PATHS.playersFile),
    manifestFile: pathText(paths.manifestFile ?? DEFAULT_QA_HINT_PATHS.manifestFile),
    craigInput: pathText(paths.craigInput ?? DEFAULT_QA_HINT_PATHS.craigInput),
    roll20Input: pathText(paths.roll20Input ?? DEFAULT_QA_HINT_PATHS.roll20Input),
  };
}

export function isIntakeQaCode(value: string): value is IntakeQaCode {
  return Object.prototype.hasOwnProperty.call(INTAKE_QA_CATALOG, value);
}

export function intakeQaDefinition(code: string): IntakeQaCodeDefinition | undefined {
  return isIntakeQaCode(code) ? INTAKE_QA_CATALOG[code] : undefined;
}

/**
 * Build a concrete repair instruction for a known code. Every branch names at
 * least one file and one field, including informational entries whose repair
 * is simply preserving evidence for the next stage.
 */
export function hintForIntakeQa(
  code: string,
  subject: string | undefined,
  paths: Partial<QaHintPaths> = {},
): string {
  const resolved = qaHintPaths(paths);
  const target = subject?.trim() || "the affected record";

  switch (code) {
    case "TRACK_UNMAPPED":
      return `update ${resolved.playersFile} players[].discord.username or players[].discord.craig_track_hints for ${target}, then rerun intake`;
    case "ROLL20_ACCOUNT_UNMAPPED":
      return `add roll20.account_name: "${target}" to the matching player in ${resolved.playersFile}, then rerun intake`;
    case "PLAYER_NO_TRACK":
      return `add or restore the player's Craig file under ${resolved.craigInput} and verify ${resolved.playersFile} players[].id, then rerun intake`;
    case "TRACK_SILENT":
      return `inspect the audio file under ${resolved.craigInput} and verify ${resolved.manifestFile} tracks[].speech_ratio; correct the source or ${resolved.playersFile} players[].discord.craig_track_hints`;
    case "TRACK_DURATION_MISMATCH":
      return `verify the outlier audio under ${resolved.craigInput} and compare ${resolved.manifestFile} tracks[].duration_s with recording.duration_s before rerunning intake`;
    case "ROLL20_WINDOW_MISMATCH":
      return `check that ${resolved.roll20Input} belongs to this session and compare ${resolved.manifestFile} recording.started_at and recording.duration_s`;
    case "TIME_BASIS_ORDER_ONLY":
      return `preserve ordered messages in ${resolved.roll20Input} and verify ${resolved.manifestFile} roll20.time_basis; provide messages[].t_wall_ms when a trusted clock is available`;
    case "ROLL20_UNPARSED_MESSAGES":
      return `preserve the raw message in ${resolved.roll20Input} and inspect ${resolved.manifestFile} roll20.path/raw_ref before updating the parser`;
    case "CRAIG_ARCHIVE_EXTRACTED":
      return `verify the archive under ${resolved.craigInput} and confirm ${resolved.manifestFile} recording.source and recording.track_count; rerun if the archive bytes changed`;
    case "CRAIG_NO_TRACKS":
      return `put the Craig zip or track files under ${resolved.craigInput} and verify ${resolved.manifestFile} recording.track_count after rerunning intake`;
    case "TRACK_NAME_UNPARSED":
      return `add the filename stem to ${resolved.playersFile} players[].discord.craig_track_hints and verify ${resolved.manifestFile} tracks[].path`;
    case "ROLL20_MESSAGEID_NON_MONOTONIC":
      return `retain message ordering in ${resolved.roll20Input} and inspect ${resolved.manifestFile} roll20.time_basis plus messages[].id/seq; let P2-09 align order-only evidence`;
    case "ROLL20_NO_CAPTURE":
      return `put roll20-capture.json or chat-archive.html under ${resolved.roll20Input} and verify ${resolved.manifestFile} roll20.path after rerunning intake`;
    default:
      return `inspect ${resolved.manifestFile} qa[] for ${target} and update the producing input file before rerunning intake`;
  }
}
