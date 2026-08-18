import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_INFO, parseInfoText, readInfoFile } from "./info.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-info-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseInfoText", () => {
  it("reads the layout Craig writes today", () => {
    const info = parseInfoText(
      [
        "Guild:\tThornwatch (853109238471923712)",
        "Channel:\tthe-table (853109238471923713)",
        "Requester:\twren_dm (204938271094857263)",
        "Start time:\t2026-08-16T23:04:11.000Z",
        "Tracks:",
        "\t1: ashcodes (111111111111111111)",
        "\t2: blybird (222222222222222222)",
        "\t3: cyd_h (333333333333333333)",
        "\t4: wren_dm (204938271094857263)",
        "",
      ].join("\n"),
    );

    expect(info.startedAt).toBe("2026-08-16T23:04:11.000Z");
    expect(info.guild).toBe("Thornwatch (853109238471923712)");
    expect(info.channel).toBe("the-table (853109238471923713)");
    expect(info.participants).toHaveLength(4);
    expect(info.participants[0]).toEqual({
      index: 1,
      username: "ashcodes",
      discriminator: null,
      userId: "111111111111111111",
    });
  });

  it("reads the older layout with no track numbers", () => {
    const info = parseInfoText(
      ["Users:", "\tashcodes#0417 (111111111111111111)", "\tblybird (222222222222222222)"].join(
        "\n",
      ),
    );

    expect(info.participants[0]).toEqual({
      index: null,
      username: "ashcodes",
      discriminator: "0417",
      userId: "111111111111111111",
    });
    expect(info.participants[1]?.discriminator).toBeNull();
  });

  it("reads the fixture generator's layout", () => {
    const info = parseInfoText(
      [
        "Recording game_fixture",
        "Started: 2026-08-16T23:04:11.000Z",
        "Channels: 4",
        "  1: ashcodes",
        "  2: blybird",
        "",
      ].join("\n"),
    );

    expect(info.startedAt).toBe("2026-08-16T23:04:11.000Z");
    expect(info.participants.map((p) => p.username)).toEqual(["ashcodes", "blybird"]);
    expect(info.participants[0]?.userId).toBeNull();
  });

  it("treats every field as optional", () => {
    const info = parseInfoText("Tracks:\n\t1: ashcodes\n");
    expect(info.startedAt).toBeNull();
    expect(info.guild).toBeNull();
    expect(info.channel).toBeNull();
    expect(info.participants).toHaveLength(1);
  });

  it("returns null rather than a guessed time for an unparseable start", () => {
    // A wrong recording start silently shifts every Roll20 alignment.
    expect(parseInfoText("Start time:\tsometime after dinner").startedAt).toBeNull();
  });

  it("normalises the start time to ISO", () => {
    expect(parseInfoText("Start time: 2026-08-16 23:04:11Z").startedAt).toBe(
      "2026-08-16T23:04:11.000Z",
    );
  });

  it("keeps a unicode display name", () => {
    const info = parseInfoText("Tracks:\n\t4: Séraphine Ω (444444444444444444)\n");
    expect(info.participants[0]?.username).toBe("Séraphine Ω");
  });

  it("collects lines it could not read instead of throwing", () => {
    const info = parseInfoText("Recording game_fixture\nSomething entirely unexpected\n");
    expect(info.unparsed).toContain("Recording game_fixture");
    expect(info.participants).toHaveLength(0);
  });

  it("survives an empty file", () => {
    expect(parseInfoText("")).toEqual(EMPTY_INFO);
  });
});

describe("readInfoFile", () => {
  it("treats a missing info.txt as empty, not as an error", () => {
    // Craig does not always include one, and it is not required to bind tracks.
    return expect(readInfoFile(join(root, "info.txt"))).resolves.toEqual(EMPTY_INFO);
  });

  it("reads a file that is there", async () => {
    const path = join(root, "info.txt");
    writeFileSync(path, "Start time: 2026-08-16T23:04:11Z\nTracks:\n\t1: ashcodes\n");
    const info = await readInfoFile(path);
    expect(info.participants[0]?.username).toBe("ashcodes");
  });
});
