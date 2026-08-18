import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTRACTED_DIRNAME, ensureExtracted, findArchive, RECEIPT_FILENAME } from "./archive.js";

let root: string;
let craigDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-archive-"));
  craigDir = join(root, "input", "craig");
  mkdirSync(craigDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A single-entry zip, built by hand so the bytes are exactly what we intend. */
function writeZip(name: string, members: Array<{ name: string; contents: Buffer }>): string {
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

  const path = join(craigDir, name);
  writeFileSync(path, Buffer.concat([...locals, directory, eocd]));
  return path;
}

const TRACKS = [
  { name: "1-ashcodes.flac", contents: Buffer.from("ash audio") },
  { name: "2-blybird.flac", contents: Buffer.from("bly audio") },
  { name: "info.txt", contents: Buffer.from("Start time: 2026-08-16T23:04:11Z\n") },
];

describe("findArchive", () => {
  it("finds nothing when the tracks are already loose", async () => {
    writeFileSync(join(craigDir, "1-ashcodes.flac"), "audio");
    expect(await findArchive(craigDir)).toBeNull();
  });

  it("prefers the largest zip when a human downloaded twice", async () => {
    writeZip("chat-export.zip", [{ name: "chat.html", contents: Buffer.from("x") }]);
    writeZip("craig-download.zip", [
      { name: "1-ashcodes.flac", contents: Buffer.from("y".repeat(4000)) },
    ]);
    expect(await findArchive(craigDir)).toBe("craig-download.zip");
  });

  it("returns null for a folder that does not exist", async () => {
    expect(await findArchive(join(root, "nope"))).toBeNull();
  });
});

describe("ensureExtracted", () => {
  it("leaves loose tracks exactly where they are", async () => {
    writeFileSync(join(craigDir, "1-ashcodes.flac"), "audio");

    const extraction = await ensureExtracted(craigDir);

    expect(extraction.trackRoot).toBe(craigDir);
    expect(extraction.archive).toBeNull();
    expect(extraction.extracted).toBe(false);
    expect(existsSync(join(craigDir, EXTRACTED_DIRNAME))).toBe(false);
  });

  it("extracts an archive once and records its hash", async () => {
    writeZip("craig.zip", TRACKS);

    const first = await ensureExtracted(craigDir);

    expect(first.extracted).toBe(true);
    expect(first.trackRoot).toBe(join(craigDir, EXTRACTED_DIRNAME));
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(first.trackRoot, "1-ashcodes.flac"), "utf8")).toBe("ash audio");

    const receipt = JSON.parse(
      readFileSync(join(first.trackRoot, RECEIPT_FILENAME), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt["sha256"]).toBe(first.sha256);
    expect(receipt["files"]).toEqual(["1-ashcodes.flac", "2-blybird.flac", "info.txt"]);
  });

  it("re-extracts nothing when the archive has not changed", async () => {
    writeZip("craig.zip", TRACKS);
    await ensureExtracted(craigDir);

    // Proves the second call did not rewrite: a marker placed inside the
    // extraction survives only if nothing re-extracted over it.
    const marker = join(craigDir, EXTRACTED_DIRNAME, "do-not-delete.txt");
    writeFileSync(marker, "still here");

    const second = await ensureExtracted(craigDir);

    expect(second.extracted).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  it("re-extracts when the archive bytes change", async () => {
    writeZip("craig.zip", TRACKS);
    await ensureExtracted(craigDir);
    const marker = join(craigDir, EXTRACTED_DIRNAME, "from-the-old-download.flac");
    writeFileSync(marker, "stale");

    // A different recording that happens to carry the same filename.
    writeZip("craig.zip", [{ name: "1-ashcodes.flac", contents: Buffer.from("different audio") }]);
    const second = await ensureExtracted(craigDir);

    expect(second.extracted).toBe(true);
    // The stale track is gone rather than merged in, which would have shown up
    // downstream as an extra participant who never spoke.
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(second.trackRoot, "1-ashcodes.flac"), "utf8")).toBe("different audio");
  });

  it("re-extracts when the extraction was deleted but the receipt survived", async () => {
    writeZip("craig.zip", TRACKS);
    const first = await ensureExtracted(craigDir);
    rmSync(join(first.trackRoot, "1-ashcodes.flac"));
    rmSync(join(first.trackRoot, "2-blybird.flac"));

    const second = await ensureExtracted(craigDir);

    expect(second.extracted).toBe(true);
    expect(existsSync(join(second.trackRoot, "1-ashcodes.flac"))).toBe(true);
  });
});
