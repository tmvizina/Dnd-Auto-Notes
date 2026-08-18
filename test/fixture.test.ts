import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GENERATOR = join(process.cwd(), "tools", "generate-fixture.mjs");

interface Truth {
  session_id: string;
  seed: number;
  recording: { started_at: string; duration_s: number; sample_rate: number };
  tracks: Array<{ player_id: string; file: string; duration_s: number; silent: boolean }>;
  utterances: Array<{
    id: string;
    player_id: string;
    start_s: number;
    end_s: number;
    mode: string;
    character_id: string | null;
    announces_roll: string | null;
  }>;
  rolls: Array<{ id: string; player_id: string; announced_by: string | null }>;
  defects: Array<{ code: string; subject: string }>;
}

function generate(out: string, ...extra: string[]): void {
  execFileSync(process.execPath, [GENERATOR, "--out", out, ...extra], { stdio: "pipe" });
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(path) : statSync(path).size;
  }
  return total;
}

function fileList(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? fileList(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

let scratch: string;
let clean: string;
let truth: Truth;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "dnd-fixture-"));
  clean = join(scratch, "clean");
  generate(clean);
  truth = JSON.parse(readFileSync(join(clean, "truth.json"), "utf8")) as Truth;
}, 60_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("fixture generator", () => {
  it("produces byte-identical output for the same seed", () => {
    const a = join(scratch, "a");
    const b = join(scratch, "b");
    generate(a);
    generate(b);

    const files = fileList(a);
    expect(files).toEqual(fileList(b));
    for (const file of files) {
      expect(readFileSync(join(a, file)).equals(readFileSync(join(b, file))), file).toBe(true);
    }
  }, 60_000);

  it("differs when the seed differs", () => {
    const other = join(scratch, "seeded");
    generate(other, "--seed", "99");
    const wav = "input/craig/1-ashcodes.wav";
    expect(readFileSync(join(clean, wav)).equals(readFileSync(join(other, wav)))).toBe(false);
  }, 60_000);

  it("stays well under the 10 MB ceiling", () => {
    expect(directorySize(clean)).toBeLessThan(10 * 1024 * 1024);
  });

  it("writes both Roll20 shapes and every input the pipeline expects", () => {
    for (const path of [
      "session.json",
      "truth.json",
      "input/craig/info.txt",
      "input/roll20/roll20-capture.json",
      "input/roll20/chat-archive.html",
      "campaign/players.json",
      "campaign/npcs.json",
      "campaign/glossary.md",
    ]) {
      expect(existsSync(join(clean, path)), path).toBe(true);
    }
    expect(fileList(join(clean, "input", "craig")).filter((f) => f.endsWith(".wav"))).toHaveLength(
      4,
    );
  });

  it("covers every generated utterance in truth.json", () => {
    expect(truth.utterances.length).toBeGreaterThan(0);
    for (const utterance of truth.utterances) {
      expect(utterance.end_s).toBeGreaterThan(utterance.start_s);
      expect(truth.tracks.some((t) => t.player_id === utterance.player_id)).toBe(true);
    }
    // An in-character line must name the character it is in; an out-of-character
    // line must not claim one.
    for (const utterance of truth.utterances) {
      if (utterance.mode === "in_character") expect(utterance.character_id).not.toBeNull();
      if (utterance.mode === "out_of_character") expect(utterance.character_id).toBeNull();
    }
  });

  it("links every roll to the utterance that announces it", () => {
    for (const roll of truth.rolls) {
      expect(roll.announced_by).not.toBeNull();
      const utterance = truth.utterances.find((u) => u.id === roll.announced_by);
      expect(utterance, roll.id).toBeDefined();
      expect(utterance?.announces_roll).toBe(roll.id);
    }
  });

  it("never overlaps two utterances on one track", () => {
    for (const track of truth.tracks) {
      const mine = truth.utterances
        .filter((u) => u.player_id === track.player_id)
        .sort((a, b) => a.start_s - b.start_s);
      for (let i = 1; i < mine.length; i += 1) {
        expect(mine[i]!.start_s).toBeGreaterThanOrEqual(mine[i - 1]!.end_s);
      }
    }
  });

  it("covers the Roll20 message kinds the parser must handle", () => {
    const capture = JSON.parse(
      readFileSync(join(clean, "input", "roll20", "roll20-capture.json"), "utf8"),
    ) as { messages: Array<{ kind: string; outer_html: string }>; turnorder_events: unknown[] };

    const kinds = new Set(capture.messages.map((m) => m.kind));
    for (const kind of ["general", "emote", "whisper", "desc", "rollresult"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(capture.turnorder_events).toHaveLength(2);
    // Raw markup is retained so parser fixes can be replayed against old captures.
    expect(capture.messages.every((m) => m.outer_html.includes("data-messageid"))).toBe(true);
    expect(capture.messages.some((m) => m.outer_html.includes("sheet-rolltemplate-atk"))).toBe(
      true,
    );
  });

  it("emits an archive page carrying the same messages", () => {
    const html = readFileSync(join(clean, "input", "roll20", "chat-archive.html"), "utf8");
    const capture = JSON.parse(
      readFileSync(join(clean, "input", "roll20", "roll20-capture.json"), "utf8"),
    ) as { messages: Array<{ id: string }> };
    expect(html).toContain('id="textchat"');
    for (const message of capture.messages) expect(html).toContain(message.id);
  });

  it("produces a clean fixture with no defects", () => {
    expect(truth.defects).toEqual([]);
    expect(truth.tracks.every((t) => !t.silent)).toBe(true);
    expect(new Set(truth.tracks.map((t) => t.duration_s)).size).toBe(1);
  });

  it("produces exactly the three defects with --with-defects", () => {
    const broken = join(scratch, "broken");
    generate(broken, "--with-defects");
    const brokenTruth = JSON.parse(readFileSync(join(broken, "truth.json"), "utf8")) as Truth;

    expect(brokenTruth.defects.map((d) => d.code).sort()).toEqual([
      "ROLL20_ACCOUNT_UNMAPPED",
      "TRACK_DURATION_MISMATCH",
      "TRACK_SILENT",
    ]);

    const players = JSON.parse(readFileSync(join(broken, "campaign", "players.json"), "utf8")) as {
      players: Array<{ id: string; roll20: { account_name?: string } }>;
    };
    expect(players.players.find((p) => p.id === "pl_cyd")?.roll20.account_name).toBeUndefined();
    expect(new Set(brokenTruth.tracks.map((t) => t.duration_s)).size).toBe(2);
    expect(brokenTruth.tracks.filter((t) => t.silent)).toHaveLength(1);
  }, 60_000);

  it("needs no ffmpeg — the WAVs are written directly", () => {
    const wav = readFileSync(join(clean, "input", "craig", "1-ashcodes.wav"));
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt16LE(34)).toBe(16); // 16-bit
    expect(wav.readUInt32LE(24)).toBe(truth.recording.sample_rate);
  });
});
