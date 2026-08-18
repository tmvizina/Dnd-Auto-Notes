import type { ValidatedArtifactName } from "../contracts/artifacts.js";

/**
 * The smallest value that satisfies each artifact contract. Tests build on
 * these rather than restating whole shapes, so a contract change breaks one
 * place instead of twenty.
 */
export const MINIMAL: { [K in ValidatedArtifactName]: unknown } = {
  manifest: {
    session_id: "2026-08-16-s42",
    recording: { started_at: null, duration_s: 0, source: "craig", track_count: 0 },
    tracks: [],
    roll20: null,
    qa: [],
  },
  intakeQa: { stage: "intake", entries: [], metrics: {} },
  transcript: { utterances: [] },
  features: {
    embedding: { backend: "fake", dimension: 4, normalised: true, blob: "features.bin" },
    min_duration_s: 0.6,
    rows: [],
  },
  attribution: {
    attributions: [],
    summary: {
      in_character: 0,
      out_of_character: 0,
      narration: 0,
      uncertain: 0,
      unknown_character: 0,
    },
  },
  timeline: {
    rolls: [],
    anchors: [],
    turnorder: [],
    quality: {
      anchored_fraction: 0,
      median_residual_s: null,
      largest_unanchored_gap_s: null,
      clock_drift_s: null,
    },
  },
  events: { events: [], beats: [], open_threads: [] },
  notesQa: { stage: "notes", entries: [], metrics: {} },
};

/** Right shape, one field made wrong — used to prove validators actually bite. */
export const CORRUPTED: { [K in ValidatedArtifactName]: unknown } = {
  manifest: {
    ...(MINIMAL.manifest as object),
    recording: { started_at: null, duration_s: -5, source: "craig", track_count: 0 },
  },
  intakeQa: { stage: "intake", entries: [{ code: "X", severity: "catastrophic", message: "m" }] },
  transcript: { utterances: [{ id: "u1", track_id: "t1", start_s: 1 }] },
  features: {
    ...(MINIMAL.features as object),
    embedding: { backend: "fake", dimension: 0, normalised: true, blob: "b" },
  },
  attribution: { attributions: [], summary: { in_character: 0 } },
  timeline: { ...(MINIMAL.timeline as object), quality: { anchored_fraction: 42 } },
  events: { events: [{ id: "e1", kind: "not-a-kind" }], beats: [] },
  notesQa: { stage: "notes", entries: [{ severity: "error" }] },
};

export const ARTIFACT_NAMES = Object.keys(MINIMAL) as ValidatedArtifactName[];
