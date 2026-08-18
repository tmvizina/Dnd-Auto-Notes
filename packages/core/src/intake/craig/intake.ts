import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Registry } from "../../campaign/registry.js";
import type { QaEntry } from "../../contracts/common.js";
import type { Track } from "../../contracts/manifest.js";
import { hashFile } from "../../stage/hash.js";
import { ensureExtracted, EXTRACTED_DIRNAME } from "./archive.js";
import type { Extraction } from "./archive.js";
import { bindTracks } from "./bind.js";
import type { Binding, BindingInput } from "./bind.js";
import { readInfoFile } from "./info.js";
import type { CraigInfo, CraigParticipant } from "./info.js";
import { isTrackFile, parseCraigName } from "./names.js";
import type { CraigName } from "./names.js";
import { createProber } from "./probe.js";
import type { TrackProber } from "./probe.js";
import { isSilent } from "./speech.js";

/**
 * Reads a Craig download into the track half of the intake manifest.
 *
 * Nothing here writes an artifact: the stage runner owns that, and keeping this
 * a pure function of the input folder is what makes the alignment check and the
 * binding rules testable against a fixture instead of against a session on disk.
 */

/**
 * Craig's multi-track download shares one t=0 across every track, so the
 * durations should agree to within a frame or two. Two seconds is slack for
 * encoder padding, not for a genuinely different recording.
 */
export const ALIGNMENT_TOLERANCE_S = 2.0;

export interface CraigIntakeOptions {
  /** The session directory; `input/craig` is read beneath it. */
  readonly sessionRoot: string;
  readonly registry: Registry;
  /** Defaults to WAV-in-process with no sidecar, which suits the fixtures. */
  readonly prober?: TrackProber;
  readonly alignmentToleranceS?: number;
}

export interface CraigIntakeResult {
  readonly recording: {
    readonly started_at: string | null;
    readonly duration_s: number;
    readonly source: "craig";
    readonly track_count: number;
  };
  readonly tracks: Track[];
  readonly qa: QaEntry[];
  readonly extraction: Extraction;
  readonly info: CraigInfo;
}

interface Discovered {
  readonly absolutePath: string;
  /** Session-relative, forward-slashed, as the manifest records it. */
  readonly path: string;
  readonly filename: string;
  readonly name: CraigName;
}

/**
 * One level deep: Craig writes tracks at the root of its archive, but some
 * clients wrap everything in a folder named after the recording.
 */
async function discoverTracks(root: string, sessionRoot: string): Promise<Discovered[]> {
  const found: Discovered[] = [];

  const scan = async (directory: string, depth: number): Promise<void> => {
    if (!existsSync(directory)) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await scan(absolutePath, depth - 1);
        continue;
      }
      if (!entry.isFile() || !isTrackFile(entry.name)) continue;
      found.push({
        absolutePath,
        path: relative(sessionRoot, absolutePath).split(sep).join("/"),
        filename: entry.name,
        name: parseCraigName(entry.name),
      });
    }
  };

  await scan(root, 1);

  // Craig numbers its tracks; anything unnumbered sorts after, by name, so the
  // manifest order is stable no matter what the filesystem returns.
  return found.sort((a, b) => {
    const left = a.name.index ?? Number.MAX_SAFE_INTEGER;
    const right = b.name.index ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.filename.localeCompare(b.filename);
  });
}

/** Craig's own index when it is free, otherwise the next unused number. */
function assignTrackIds(discovered: readonly Discovered[]): string[] {
  const taken = new Set<number>();
  const ids: (number | null)[] = discovered.map((item) => {
    const index = item.name.index;
    if (index === null || index <= 0 || taken.has(index)) return null;
    taken.add(index);
    return index;
  });

  let next = 1;
  return ids.map((index) => {
    if (index !== null) return `t${String(index)}`;
    while (taken.has(next)) next += 1;
    taken.add(next);
    return `t${String(next)}`;
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Matches an `info.txt` row to a track by Craig's index, then by exact name. */
function participantFor(info: CraigInfo, name: CraigName): CraigParticipant | null {
  if (name.index !== null) {
    const byIndex = info.participants.find((participant) => participant.index === name.index);
    if (byIndex !== undefined) return byIndex;
  }
  const wanted = name.username.toLowerCase();
  return (
    info.participants.find((participant) => participant.username.toLowerCase() === wanted) ?? null
  );
}

function describeCandidates(binding: Binding): string {
  if (binding.candidates.length === 0) return "no candidates above the suggestion threshold";
  return binding.candidates
    .map((candidate) => `${candidate.player_id} (${candidate.score.toFixed(2)})`)
    .join(", ");
}

export async function craigIntake(options: CraigIntakeOptions): Promise<CraigIntakeResult> {
  const { sessionRoot, registry } = options;
  const tolerance = options.alignmentToleranceS ?? ALIGNMENT_TOLERANCE_S;
  const prober = options.prober ?? createProber();
  const craigDir = join(sessionRoot, "input", "craig");
  const qa: QaEntry[] = [];

  const extraction = await ensureExtracted(craigDir);

  // A previous run's extraction with the archive since deleted still holds the
  // only copy of the audio; refusing to look there would lose the session.
  let trackRoot = extraction.trackRoot;
  let discovered = await discoverTracks(trackRoot, sessionRoot);
  if (discovered.length === 0 && extraction.archive === null) {
    const fallback = join(craigDir, EXTRACTED_DIRNAME);
    const fromFallback = await discoverTracks(fallback, sessionRoot);
    if (fromFallback.length > 0) {
      trackRoot = fallback;
      discovered = fromFallback;
    }
  }

  if (extraction.archive !== null && extraction.extracted) {
    qa.push({
      code: "CRAIG_ARCHIVE_EXTRACTED",
      severity: "info",
      message: `extracted ${extraction.archive} to ${EXTRACTED_DIRNAME}/`,
      subject: extraction.archive,
      hint: `sha256 ${extraction.sha256 ?? "unknown"} — a re-run reuses this extraction unless the archive changes`,
    });
  }

  if (discovered.length === 0) {
    qa.push({
      code: "CRAIG_NO_TRACKS",
      severity: "error",
      message: "no audio tracks found in the Craig input",
      subject: craigDir,
      hint: `put the Craig download (zip or extracted folder) in ${join("input", "craig")}`,
    });
    return {
      recording: { started_at: null, duration_s: 0, source: "craig", track_count: 0 },
      tracks: [],
      qa,
      extraction,
      info: await readInfoFile(join(craigDir, "info.txt")),
    };
  }

  const infoPath = existsSync(join(trackRoot, "info.txt"))
    ? join(trackRoot, "info.txt")
    : join(craigDir, "info.txt");
  const info = await readInfoFile(infoPath);

  for (const item of discovered) {
    if (item.name.warning !== null) {
      qa.push({
        code: "TRACK_NAME_UNPARSED",
        severity: "warning",
        message: `"${item.filename}" does not follow Craig's <index>-<username> convention (${item.name.warning})`,
        subject: item.path,
        hint: `matching falls back to the raw name "${item.name.stem}"; add it to discord.craig_track_hints in campaign/players.json if it should bind to a player`,
      });
    }
  }

  const trackIds = assignTrackIds(discovered);

  // Probe and hash before binding: the alignment verdict is a property of the
  // whole set, so nothing can be finalised one track at a time.
  const measured = [];
  for (const [ordinal, item] of discovered.entries()) {
    const trackId = trackIds[ordinal] ?? `t${String(ordinal + 1)}`;
    const probe = await prober.probe(item.absolutePath);
    const sha256 = await hashFile(item.absolutePath);
    measured.push({ item, trackId, probe, sha256 });
  }

  const durations = measured.map((entry) => entry.probe.duration_s);
  const reference = median(durations);
  const outliers = measured.filter(
    (entry) => Math.abs(entry.probe.duration_s - reference) > tolerance,
  );

  if (outliers.length > 0) {
    qa.push({
      code: "TRACK_DURATION_MISMATCH",
      severity: "error",
      message:
        `${String(outliers.length)} track(s) disagree with the ${reference.toFixed(2)}s median by more than ${tolerance.toFixed(1)}s: ` +
        outliers
          .map((entry) => `${entry.trackId} (${entry.probe.duration_s.toFixed(2)}s)`)
          .join(", "),
      subject: outliers.map((entry) => entry.trackId).join(","),
      // Craig's tracks share a t=0 by construction, so a disagreement means the
      // folder holds audio from more than one recording — not a trimmed track.
      hint: "Craig tracks share one t=0; check input/craig for files from a different recording before trusting any cross-track timestamp",
    });
  }

  const bindingInputs: BindingInput[] = measured.map((entry) => ({
    trackId: entry.trackId,
    name: entry.item.name,
    participant: participantFor(info, entry.item.name),
  }));
  const bindings = bindTracks(registry, bindingInputs);

  const tracks: Track[] = measured.map((entry, ordinal) => {
    const binding = bindings[ordinal];
    const aligned = !outliers.includes(entry);
    return {
      track_id: entry.trackId,
      path: entry.item.path,
      player_id: binding?.playerId ?? null,
      match: binding?.match ?? "unmatched",
      ...(binding?.score === undefined ? {} : { match_score: binding.score }),
      sha256: entry.sha256,
      duration_s: entry.probe.duration_s,
      sample_rate: entry.probe.sample_rate,
      channels: entry.probe.channels,
      ...(entry.probe.codec === undefined ? {} : { codec: entry.probe.codec }),
      speech_ratio: entry.probe.speech_ratio,
      aligned,
    };
  });

  for (const [ordinal, track] of tracks.entries()) {
    const binding = bindings[ordinal];
    if (track.player_id === null && binding !== undefined) {
      qa.push({
        code: "TRACK_UNMAPPED",
        severity: "error",
        message: `${track.track_id} (${measured[ordinal]?.item.filename ?? track.path}) could not be bound to a player: ${binding.reason}`,
        subject: track.track_id,
        hint: `candidates: ${describeCandidates(binding)} — set discord.username or add the filename to discord.craig_track_hints in campaign/players.json`,
      });
    }
    if (isSilent(track.speech_ratio)) {
      qa.push({
        code: "TRACK_SILENT",
        severity: "warning",
        message: `${track.track_id} carries almost no speech (speech_ratio ${track.speech_ratio.toFixed(4)})`,
        subject: track.track_id,
        hint: "the participant was muted, absent, or recorded on the wrong device; their lines will be missing from the notes",
      });
    }
  }

  return {
    recording: {
      started_at: info.startedAt,
      // The longest track, not the median: the recording ran until its last
      // participant stopped, and truncating the clock would drop their audio.
      duration_s: Number(Math.max(...durations).toFixed(6)),
      source: "craig",
      track_count: tracks.length,
    },
    tracks,
    qa,
    extraction,
    info,
  };
}
