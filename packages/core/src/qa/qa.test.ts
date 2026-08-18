import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QaEntry } from "../contracts/common.js";
import type { Manifest, Track } from "../contracts/manifest.js";
import { createSession } from "../session/session.js";
import { closeDb, openDb } from "../db/db.js";
import { listFlags, resolveFlag, upsertSession } from "../db/records.js";
import {
  DEFAULT_QA_HINT_PATHS,
  INTAKE_QA_CATALOG,
  buildIntakeQaReport,
  checkIntakeQa,
  hintForIntakeQa,
  mirrorQaFlags,
  qaExitCode,
  qaFlagsForReport,
  readIntakeQaReport,
  renderQaTable,
  serializeQaReport,
  writeIntakeQaReport,
} from "./index.js";
import type { QaRegistry } from "./checks.js";

const SHA = "a".repeat(64);
const TRACKS: Track[] = [
  {
    track_id: "t1",
    path: "input/craig/1-ash.wav",
    player_id: "pl_ash",
    match: "username",
    sha256: SHA,
    duration_s: 60,
    sample_rate: 8_000,
    channels: 1,
    speech_ratio: 0.25,
    aligned: true,
  },
  {
    track_id: "t2",
    path: "input/craig/2-bly.wav",
    player_id: "pl_bly",
    match: "username",
    sha256: SHA,
    duration_s: 60,
    sample_rate: 8_000,
    channels: 1,
    speech_ratio: 0.25,
    aligned: true,
  },
  {
    track_id: "t3",
    path: "input/craig/3-cyd.wav",
    player_id: "pl_cyd",
    match: "username",
    sha256: SHA,
    duration_s: 60,
    sample_rate: 8_000,
    channels: 1,
    speech_ratio: 0.25,
    aligned: true,
  },
  {
    track_id: "t4",
    path: "input/craig/4-dm.wav",
    player_id: "pl_dm",
    match: "username",
    sha256: SHA,
    duration_s: 60,
    sample_rate: 8_000,
    channels: 1,
    speech_ratio: 0.25,
    aligned: true,
  },
];

const REGISTRY: QaRegistry = {
  players: [
    { id: "pl_ash", display_name: "Ash" },
    { id: "pl_bly", display_name: "Bly" },
    { id: "pl_cyd", display_name: "Cyd" },
    { id: "pl_dm", display_name: "DM", is_dm: true },
  ],
};

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    session_id: "2026-08-16-fixture",
    recording: {
      started_at: "2026-08-16T23:04:11.000Z",
      duration_s: 60,
      source: "craig",
      track_count: TRACKS.length,
    },
    tracks: TRACKS.map((track) => ({ ...track })),
    rolls: [
      {
        id: "r0001",
        seq: 1,
        who: "Ash",
        player_id: "pl_ash",
        formula: "1d20",
        dice: [{ sides: 20, value: 14, dropped: false }],
        modifiers: 0,
        total: 14,
        roll_kind: "check",
        advantage: "none",
        raw_ref: "roll-1",
      },
    ],
    roll20: {
      path: "input/roll20/roll20-capture.json",
      sha256: SHA,
      message_count: 1,
      roll_count: 1,
      capture_mode: "live",
      time_basis: "wallclock",
    },
    qa: [],
    ...overrides,
  };
}

function qaEntry(code: string, severity: QaEntry["severity"]): QaEntry {
  return {
    code,
    severity,
    message: `fixture evidence for ${code}`,
    subject: "fixture-subject",
    hint: "old producer hint",
  };
}

function codes(input: Parameters<typeof checkIntakeQa>[0]): string[] {
  return checkIntakeQa(input).map((entry) => entry.code);
}

describe("intake QA catalog and checks", () => {
  it("has one stable definition for every intake code", () => {
    expect(Object.keys(INTAKE_QA_CATALOG)).toEqual([
      "TRACK_UNMAPPED",
      "ROLL20_ACCOUNT_UNMAPPED",
      "PLAYER_NO_TRACK",
      "TRACK_SILENT",
      "TRACK_DURATION_MISMATCH",
      "ROLL20_WINDOW_MISMATCH",
      "TIME_BASIS_ORDER_ONLY",
      "ROLL20_UNPARSED_MESSAGES",
      "CRAIG_ARCHIVE_EXTRACTED",
      "CRAIG_NO_TRACKS",
      "TRACK_NAME_UNPARSED",
      "ROLL20_MESSAGEID_NON_MONOTONIC",
      "ROLL20_NO_CAPTURE",
    ]);
  });

  it("keeps the clean synthetic shape free of entries", () => {
    const report = buildIntakeQaReport({ manifest: manifest(), registry: REGISTRY });
    expect(report.entries).toEqual([]);
    expect(report.metrics).toEqual({ entries: 0, errors: 0, warnings: 0, infos: 0 });
    expect(qaExitCode(report)).toBe(0);
  });

  it("reports every explicit active player when Craig has no tracks", () => {
    const report = buildIntakeQaReport({
      manifest: manifest({
        tracks: [],
        recording: { ...manifest().recording, duration_s: 0, track_count: 0 },
      }),
      registry: REGISTRY,
      activePlayerIds: ["pl_ash", "pl_cyd"],
    });

    expect(
      report.entries
        .filter((entry) => entry.code === "PLAYER_NO_TRACK")
        .map((entry) => entry.subject),
    ).toEqual(["pl_ash", "pl_cyd"]);
  });

  it("finds exactly the three defects in the synthetic defect shape", () => {
    const tracks = TRACKS.map((track) => ({ ...track }));
    tracks[1] = { ...tracks[1]!, speech_ratio: 0 };
    tracks[2] = { ...tracks[2]!, duration_s: 57, aligned: false };
    const rolls = manifest().rolls.map((roll) => ({ ...roll, player_id: null, who: "Cyd" }));
    const report = buildIntakeQaReport({
      manifest: manifest({ tracks, rolls }),
      registry: REGISTRY,
    });

    expect(report.entries).toHaveLength(3);
    expect(report.entries.map((entry) => entry.code).sort()).toEqual([
      "ROLL20_ACCOUNT_UNMAPPED",
      "TRACK_DURATION_MISMATCH",
      "TRACK_SILENT",
    ]);
    expect(report.metrics).toEqual({ entries: 3, errors: 2, warnings: 1, infos: 0 });
    expect(qaExitCode(report)).toBe(2);
  });

  it("fires every catalog code alone on purpose-built evidence", () => {
    const cases: Array<{ code: string; input: Parameters<typeof checkIntakeQa>[0] }> = [
      {
        code: "TRACK_UNMAPPED",
        input: { manifest: manifest({ tracks: [{ ...TRACKS[0]!, player_id: null }] }) },
      },
      {
        code: "ROLL20_ACCOUNT_UNMAPPED",
        input: { manifest: manifest({ rolls: [{ ...manifest().rolls[0]!, player_id: null }] }) },
      },
      {
        code: "PLAYER_NO_TRACK",
        input: {
          manifest: manifest(),
          registry: {
            players: [...REGISTRY.players, { id: "pl_extra", display_name: "Extra" }],
          },
          activePlayerIds: ["pl_extra"],
        },
      },
      {
        code: "TRACK_SILENT",
        input: { manifest: manifest({ tracks: [{ ...TRACKS[0]!, speech_ratio: 0 }] }) },
      },
      {
        code: "TRACK_DURATION_MISMATCH",
        input: {
          manifest: manifest({ tracks: [{ ...TRACKS[0]!, duration_s: 57, aligned: false }] }),
        },
      },
      {
        code: "ROLL20_WINDOW_MISMATCH",
        input: { manifest: manifest({ qa: [qaEntry("ROLL20_WINDOW_MISMATCH", "warning")] }) },
      },
      {
        code: "TIME_BASIS_ORDER_ONLY",
        input: {
          manifest: manifest({ roll20: { ...manifest().roll20!, time_basis: "order_only" } }),
        },
      },
      {
        code: "ROLL20_UNPARSED_MESSAGES",
        input: { manifest: manifest({ qa: [qaEntry("ROLL20_UNPARSED_MESSAGES", "warning")] }) },
      },
      {
        code: "CRAIG_ARCHIVE_EXTRACTED",
        input: { manifest: manifest({ qa: [qaEntry("CRAIG_ARCHIVE_EXTRACTED", "info")] }) },
      },
      {
        code: "CRAIG_NO_TRACKS",
        input: {
          manifest: manifest({
            tracks: [],
            recording: { ...manifest().recording, track_count: 0, duration_s: 0 },
          }),
        },
      },
      {
        code: "TRACK_NAME_UNPARSED",
        input: { manifest: manifest({ qa: [qaEntry("TRACK_NAME_UNPARSED", "warning")] }) },
      },
      {
        code: "ROLL20_MESSAGEID_NON_MONOTONIC",
        input: {
          manifest: manifest({ qa: [qaEntry("ROLL20_MESSAGEID_NON_MONOTONIC", "warning")] }),
        },
      },
      {
        code: "ROLL20_NO_CAPTURE",
        input: { manifest: manifest({ roll20: null }) },
      },
    ];

    for (const item of cases) {
      expect(codes(item.input), item.code).toEqual([item.code]);
    }
  });

  it("makes every known entry actionable with a file and field", () => {
    const entries = Object.keys(INTAKE_QA_CATALOG).map((code) => ({
      code,
      hint: hintForIntakeQa(code, "fixture", DEFAULT_QA_HINT_PATHS),
    }));
    for (const entry of entries) {
      expect(entry.hint, entry.code).toMatch(/(?:\.json|input\/craig|input\/roll20)/);
      expect(entry.hint, entry.code).toMatch(
        /(?:players\[\]|recording\.|tracks\[\]|roll20\.|messages\[\]|qa\[\]|raw_ref|players\.json)/,
      );
    }

    const report = buildIntakeQaReport({
      manifest: manifest({ qa: [qaEntry("TRACK_NAME_UNPARSED", "warning")] }),
    });
    expect(report.entries[0]?.hint).toContain("campaign/players.json");
  });

  it("does not duplicate a producer-emitted order-only finding", () => {
    const input = manifest({
      roll20: { ...manifest().roll20!, time_basis: "order_only" },
      qa: [qaEntry("TIME_BASIS_ORDER_ONLY", "info")],
    });
    expect(codes({ manifest: input })).toEqual(["TIME_BASIS_ORDER_ONLY"]);
  });
});

describe("intake QA rendering, persistence, and flags", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("renders terminal tables and JSON deterministically", () => {
    const tracks = TRACKS.map((track) => ({ ...track }));
    tracks[1] = { ...tracks[1]!, speech_ratio: 0 };
    tracks[2] = { ...tracks[2]!, duration_s: 57, aligned: false };
    const report = buildIntakeQaReport({
      manifest: manifest({
        tracks,
        rolls: [{ ...manifest().rolls[0]!, player_id: null, who: "Cyd" }],
      }),
      registry: REGISTRY,
    });
    expect(renderQaTable(report)).toBe(renderQaTable(report));
    expect(renderQaTable(report)).toContain("| severity");
    expect(renderQaTable(report)).toContain("summary: 2 error(s), 1 warning(s), 0 info");
    expect(serializeQaReport(report)).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  it("writes and reads the validated qa.json artifact byte-for-byte", async () => {
    root = mkdtempSync(join(tmpdir(), "dnd-qa-report-"));
    const session = await createSession(root, { title: "QA fixture", date: "2026-08-16" });
    const report = buildIntakeQaReport({ manifest: manifest(), registry: REGISTRY });
    await writeIntakeQaReport(session, report);
    const bytes = readFileSync(session.paths.artifact("intakeQa"), "utf8");
    expect(bytes).toBe(serializeQaReport(report));
    expect(await readIntakeQaReport(session)).toEqual(report);
  });

  it("mirrors open entries into flags and preserves a human resolution", () => {
    const tracks = TRACKS.map((track) => ({ ...track }));
    tracks[1] = { ...tracks[1]!, speech_ratio: 0 };
    tracks[2] = { ...tracks[2]!, duration_s: 57, aligned: false };
    const report = buildIntakeQaReport({
      manifest: manifest({
        tracks,
        rolls: [{ ...manifest().rolls[0]!, player_id: null, who: "Cyd" }],
      }),
      registry: REGISTRY,
    });
    const db = openDb(":memory:");
    try {
      upsertSession(db, {
        session_id: manifest().session_id,
        title: "QA fixture",
        number: null,
        date: "2026-08-16",
        root_path: "/qa-fixture",
      });
      expect(qaFlagsForReport(manifest().session_id, report)).toHaveLength(3);
      expect(mirrorQaFlags(db, manifest().session_id, report)).toBe(3);
      const first = listFlags(db, manifest().session_id, { status: "open" });
      expect(first.map((flag) => flag.code).sort()).toEqual([
        "ROLL20_ACCOUNT_UNMAPPED",
        "TRACK_DURATION_MISMATCH",
        "TRACK_SILENT",
      ]);
      resolveFlag(db, first[0]!.flag_id, { status: "resolved", resolved_by: "fixture" });
      mirrorQaFlags(db, manifest().session_id, report);
      expect(
        listFlags(db, manifest().session_id).find((flag) => flag.flag_id === first[0]!.flag_id),
      ).toMatchObject({ status: "resolved" });
    } finally {
      closeDb(db);
    }
  });
});
