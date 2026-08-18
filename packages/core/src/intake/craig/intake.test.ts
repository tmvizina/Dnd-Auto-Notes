import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRegistry } from "../../campaign/registry.js";
import type { Registry } from "../../campaign/registry.js";
import { Manifest } from "../../contracts/manifest.js";
import { craigIntake } from "./intake.js";
import type { CraigIntakeResult } from "./intake.js";

/**
 * The end-to-end proof for `P1-03`, run against the real generated fixture
 * rather than a hand-written stub: durations, energy and hashes are all
 * measured off actual WAV bytes, with no ffmpeg and no sidecar process.
 */

const GENERATOR = join(process.cwd(), "tools", "generate-fixture.mjs");

let root: string;
let clean: string;
let defective: string;

function generate(out: string, ...extra: string[]): void {
  execFileSync(process.execPath, [GENERATOR, "--out", out, ...extra], { stdio: "pipe" });
}

async function intakeOf(sessionRoot: string): Promise<CraigIntakeResult> {
  const registry = await loadRegistry(join(sessionRoot, "campaign"));
  return craigIntake({ sessionRoot, registry });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-intake-"));
  clean = join(root, "clean");
  defective = join(root, "defective");
  generate(clean);
  generate(defective, "--with-defects");
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the clean synthetic fixture", () => {
  it("produces one track per generated file with correct durations", async () => {
    const result = await intakeOf(clean);

    expect(result.tracks).toHaveLength(4);
    expect(result.tracks.map((track) => track.track_id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(result.tracks.map((track) => track.duration_s)).toEqual([60, 60, 60, 60]);
    expect(result.recording.duration_s).toBe(60);
    expect(result.recording.track_count).toBe(4);
    expect(result.tracks.every((track) => track.sample_rate === 8000)).toBe(true);
  });

  it("binds every track to its player without guessing", async () => {
    const result = await intakeOf(clean);

    expect(result.tracks.map((track) => track.player_id)).toEqual([
      "pl_ash",
      "pl_bly",
      "pl_cyd",
      "pl_dm",
    ]);
    expect(result.tracks.every((track) => track.match === "username")).toBe(true);
    expect(result.tracks.every((track) => track.match_score === undefined)).toBe(true);
  });

  it("reads the recording start from info.txt", async () => {
    const result = await intakeOf(clean);
    expect(result.recording.started_at).toBe("2026-08-16T23:04:11.000Z");
    expect(result.info.participants).toHaveLength(4);
  });

  it("hashes every track", async () => {
    const result = await intakeOf(clean);
    const hashes = new Set(result.tracks.map((track) => track.sha256));
    expect(hashes.size).toBe(4);
    for (const hash of hashes) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records session-relative forward-slashed paths", async () => {
    const result = await intakeOf(clean);
    expect(result.tracks[0]?.path).toBe("input/craig/1-ashcodes.wav");
  });

  it("finds every track aligned and reports no errors", async () => {
    const result = await intakeOf(clean);
    expect(result.tracks.every((track) => track.aligned)).toBe(true);
    expect(result.qa.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("measures a real speech ratio per track", async () => {
    const result = await intakeOf(clean);
    for (const track of result.tracks) {
      expect(track.speech_ratio).toBeGreaterThan(0.005);
      expect(track.speech_ratio).toBeLessThan(1);
    }
  });

  it("produces a manifest that satisfies the contract", async () => {
    const result = await intakeOf(clean);
    const parsed = Manifest.safeParse({
      session_id: "2026-08-16-fixture",
      recording: result.recording,
      tracks: result.tracks,
      roll20: null,
      qa: result.qa,
    });
    expect(parsed.success).toBe(true);
  });

  it("is deterministic across runs", async () => {
    const first = await intakeOf(clean);
    const second = await intakeOf(clean);
    expect(JSON.stringify(second.tracks)).toBe(JSON.stringify(first.tracks));
    expect(JSON.stringify(second.qa)).toBe(JSON.stringify(first.qa));
  });
});

describe("the --with-defects fixture", () => {
  it("sets aligned: false and names the outlier track", async () => {
    const result = await intakeOf(defective);

    const short = result.tracks.find((track) => track.player_id === "pl_cyd");
    expect(short?.duration_s).toBe(57);
    expect(short?.aligned).toBe(false);
    // Only the outlier loses alignment; the rest are still usable.
    expect(result.tracks.filter((track) => !track.aligned)).toHaveLength(1);

    const entry = result.qa.find((item) => item.code === "TRACK_DURATION_MISMATCH");
    expect(entry?.severity).toBe("error");
    expect(entry?.message).toContain("t3");
    expect(entry?.message).toContain("57.00s");
    expect(entry?.hint).toBeTruthy();
  });

  it("reports the silent track with a near-zero speech ratio", async () => {
    const result = await intakeOf(defective);

    const silent = result.tracks.find((track) => track.player_id === "pl_bly");
    expect(silent?.speech_ratio).toBe(0);

    const entry = result.qa.find((item) => item.code === "TRACK_SILENT");
    expect(entry?.severity).toBe("warning");
    expect(entry?.subject).toBe("t2");
  });

  it("still binds and measures every other track", async () => {
    const result = await intakeOf(defective);
    expect(result.tracks).toHaveLength(4);
    expect(result.tracks.every((track) => track.player_id !== null)).toBe(true);
  });
});

describe("an unmapped participant", () => {
  let unmapped: string;

  beforeAll(() => {
    unmapped = join(root, "unmapped");
    generate(unmapped);

    // Take Cyd's Discord identity away, leaving a track no player answers to.
    const playersPath = join(unmapped, "campaign", "players.json");
    const players = JSON.parse(readFileSync(playersPath, "utf8")) as {
      players: Array<{
        id: string;
        display_name: string;
        discord: { username?: string; craig_track_hints: string[] };
        roll20: { account_name?: string };
      }>;
    };
    const cyd = players.players.find((player) => player.id === "pl_cyd");
    if (cyd !== undefined) {
      cyd.discord = { craig_track_hints: [] };
      cyd.display_name = "Someone Entirely Different";
    }
    writeFileSync(playersPath, `${JSON.stringify(players, null, 2)}\n`);
  }, 60_000);

  it("leaves player_id null rather than guessing", async () => {
    const result = await intakeOf(unmapped);
    const track = result.tracks.find((item) => item.track_id === "t3");

    expect(track?.player_id).toBeNull();
    expect(track?.match).toBe("unmatched");
  });

  it("emits a TRACK_UNMAPPED error naming the candidates", async () => {
    const result = await intakeOf(unmapped);
    const entry = result.qa.find((item) => item.code === "TRACK_UNMAPPED");

    expect(entry?.severity).toBe("error");
    expect(entry?.subject).toBe("t3");
    expect(entry?.hint).toContain("candidates:");
    expect(entry?.hint).toContain("players.json");
  });

  it("does not steal a player already bound to another track", async () => {
    const result = await intakeOf(unmapped);
    const bound = result.tracks.filter((track) => track.player_id !== null);
    expect(new Set(bound.map((track) => track.player_id)).size).toBe(bound.length);
  });
});

describe("an empty Craig folder", () => {
  it("reports it rather than producing an empty manifest silently", async () => {
    const empty = join(root, "empty");
    generate(empty);
    rmSync(join(empty, "input", "craig"), { recursive: true, force: true });

    const registry: Registry = await loadRegistry(join(empty, "campaign"));
    const result = await craigIntake({ sessionRoot: empty, registry });

    expect(result.tracks).toEqual([]);
    expect(result.qa.some((entry) => entry.code === "CRAIG_NO_TRACKS")).toBe(true);
    expect(result.recording.duration_s).toBe(0);
  });
});

describe("the alignment tolerance", () => {
  it("is configurable, and a wider one accepts the short track", async () => {
    const registry = await loadRegistry(join(defective, "campaign"));
    const result = await craigIntake({
      sessionRoot: defective,
      registry,
      alignmentToleranceS: 5,
    });

    expect(result.tracks.every((track) => track.aligned)).toBe(true);
    expect(result.qa.some((entry) => entry.code === "TRACK_DURATION_MISMATCH")).toBe(false);
  });
});

describe("a downloaded archive instead of an extracted folder", () => {
  let zipped: string;

  beforeAll(() => {
    zipped = join(root, "zipped");
    generate(zipped);

    // Repackage the generated input/craig as the zip Craig actually hands back.
    const craigDir = join(zipped, "input", "craig");
    const members = readdirSync(craigDir).map((name) => ({
      name,
      contents: readFileSync(join(craigDir, name)),
    }));
    rmSync(craigDir, { recursive: true, force: true });
    mkdirSync(craigDir, { recursive: true });
    writeFileSync(join(craigDir, "craig-download.zip"), buildZip(members));
  }, 60_000);

  it("extracts it and measures the same tracks", async () => {
    const result = await intakeOf(zipped);

    expect(result.tracks).toHaveLength(4);
    expect(result.tracks.map((track) => track.duration_s)).toEqual([60, 60, 60, 60]);
    expect(result.tracks.map((track) => track.player_id)).toEqual([
      "pl_ash",
      "pl_bly",
      "pl_cyd",
      "pl_dm",
    ]);
    expect(result.tracks[0]?.path).toBe("input/craig/extracted/1-ashcodes.wav");
    expect(result.recording.started_at).toBe("2026-08-16T23:04:11.000Z");
  });

  it("records the extraction in the manifest QA", async () => {
    // The first run of this suite already extracted it, so force a fresh one.
    rmSync(join(zipped, "input", "craig", "extracted"), { recursive: true, force: true });
    const first = await intakeOf(zipped);

    const entry = first.qa.find((item) => item.code === "CRAIG_ARCHIVE_EXTRACTED");
    expect(entry?.severity).toBe("info");
    expect(entry?.subject).toBe("craig-download.zip");
    expect(entry?.hint).toContain("sha256");
  });

  it("re-extracts nothing and produces identical output on a re-run", async () => {
    const first = await intakeOf(zipped);
    const second = await intakeOf(zipped);

    expect(second.extraction.extracted).toBe(false);
    expect(JSON.stringify(second.tracks)).toBe(JSON.stringify(first.tracks));
    // The extraction notice fires once, on the run that actually did the work.
    expect(second.qa.some((entry) => entry.code === "CRAIG_ARCHIVE_EXTRACTED")).toBe(false);
  });
});

/** Deflated zip built by hand, so the test depends on no external zip tool. */
function buildZip(members: Array<{ name: string; contents: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const nameBytes = Buffer.from(member.name, "utf8");
    const payload = deflateRawSync(member.contents);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(member.contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(member.contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}
