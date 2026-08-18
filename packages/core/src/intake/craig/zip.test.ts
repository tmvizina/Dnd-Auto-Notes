import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZip, isZip, readCentralDirectory, safeJoin, ZipError } from "./zip.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dnd-zip-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Member {
  name: string;
  contents: Buffer;
  /** 0 = stored, 8 = deflate. */
  method?: number;
}

/**
 * Builds a real zip by hand. Shelling out to a zip tool would make the test
 * depend on whatever the machine happens to have installed, and the point here
 * is to prove the reader against bytes we control exactly.
 */
function buildZip(name: string, members: Member[]): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const method = member.method ?? 8;
    const nameBytes = Buffer.from(member.name, "utf8");
    const payload = method === 0 ? member.contents : deflateRawSync(member.contents);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 name
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc, unread
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(member.contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
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

  const path = join(root, name);
  writeFileSync(path, Buffer.concat([...locals, directory, eocd]));
  return path;
}

describe("isZip", () => {
  it("recognises a zip by its local header", async () => {
    const path = buildZip("craig.zip", [{ name: "a.txt", contents: Buffer.from("hi") }]);
    expect(await isZip(path)).toBe(true);
  });

  it("rejects anything else without throwing", async () => {
    const path = join(root, "info.txt");
    writeFileSync(path, "Guild: Thornwatch");
    expect(await isZip(path)).toBe(false);
    expect(await isZip(join(root, "absent.zip"))).toBe(false);
  });
});

describe("readCentralDirectory", () => {
  it("lists every entry", async () => {
    const path = buildZip("craig.zip", [
      { name: "2-blybird.flac", contents: Buffer.from("bly") },
      { name: "1-ashcodes.flac", contents: Buffer.from("ash") },
      { name: "info.txt", contents: Buffer.from("Guild: Thornwatch") },
    ]);

    const entries = await readCentralDirectory(path);
    // Sorted, so extraction order does not depend on the archiver's layout.
    expect(entries.map((entry) => entry.name)).toEqual([
      "1-ashcodes.flac",
      "2-blybird.flac",
      "info.txt",
    ]);
  });

  it("refuses a file with no end-of-central-directory record", async () => {
    const path = join(root, "truncated.zip");
    writeFileSync(path, Buffer.from("PK and then nothing useful"));
    await expect(readCentralDirectory(path)).rejects.toBeInstanceOf(ZipError);
  });
});

describe("extractZip", () => {
  it("inflates deflated entries", async () => {
    const contents = Buffer.from("x".repeat(5000));
    const path = buildZip("craig.zip", [{ name: "1-ashcodes.flac", contents }]);

    const written = await extractZip(path, join(root, "extracted"));

    expect(written).toHaveLength(1);
    expect(readFileSync(written[0] ?? "")).toEqual(contents);
  });

  it("copies stored entries verbatim", async () => {
    const contents = Buffer.from([0, 1, 2, 250, 255]);
    const path = buildZip("craig.zip", [{ name: "1-ashcodes.flac", contents, method: 0 }]);

    const written = await extractZip(path, join(root, "extracted"));
    expect(readFileSync(written[0] ?? "")).toEqual(contents);
  });

  it("handles an empty entry", async () => {
    const path = buildZip("craig.zip", [
      { name: "2-blybird.flac", contents: Buffer.alloc(0), method: 0 },
    ]);
    const written = await extractZip(path, join(root, "extracted"));
    expect(readFileSync(written[0] ?? "").length).toBe(0);
  });

  it("keeps a unicode display name intact", async () => {
    // The filename is the binding key for a whole audio track, so mangling it
    // to latin-1 would cost a participant.
    const path = buildZip("craig.zip", [{ name: "4-Séraphine.flac", contents: Buffer.from("s") }]);
    const entries = await readCentralDirectory(path);
    expect(entries[0]?.name).toBe("4-Séraphine.flac");
  });

  it("writes nested entries under the destination", async () => {
    const path = buildZip("craig.zip", [
      { name: "rec-123/1-ashcodes.flac", contents: Buffer.from("ash") },
    ]);
    const written = await extractZip(path, join(root, "extracted"));
    expect(written[0]).toContain("rec-123");
    expect(readFileSync(written[0] ?? "").toString()).toBe("ash");
  });

  it("refuses an entry that would escape the destination", async () => {
    const path = buildZip("evil.zip", [
      { name: "../../escaped.flac", contents: Buffer.from("no") },
    ]);
    // The path is stripped rather than honoured, so it lands inside.
    const written = await extractZip(path, join(root, "extracted"));
    expect(written[0]).toContain(join(root, "extracted"));
  });

  it("refuses a compression method it cannot read", async () => {
    const path = buildZip("craig.zip", [
      { name: "1-ash.flac", contents: Buffer.from("x"), method: 14 },
    ]);
    await expect(extractZip(path, join(root, "extracted"))).rejects.toThrow(/method 14/);
  });
});

describe("safeJoin", () => {
  it("strips leading traversal rather than escaping", () => {
    expect(safeJoin(join(root, "out"), "../../etc/passwd")).toBe(
      join(root, "out", "etc", "passwd"),
    );
    expect(safeJoin(join(root, "out"), "/absolute.flac")).toBe(join(root, "out", "absolute.flac"));
  });

  it("refuses an entry with no usable path", () => {
    expect(() => safeJoin(join(root, "out"), "..")).toThrow(ZipError);
  });
});
