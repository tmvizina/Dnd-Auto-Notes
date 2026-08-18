import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

/**
 * A reader for the one kind of zip this project meets: the archive Craig hands
 * back from a download. Node ships deflate but no zip container, and the rest
 * of this codebase writes its own small formats rather than taking a
 * dependency for one call site.
 *
 * Entries stream through `inflateRaw` to disk — a session archive is gigabytes
 * of FLAC, and buffering one would defeat the point of hashing it in a stream.
 */

export class ZipError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

/** Present in a size field when the real value lives in a zip64 extra field. */
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

async function readTail(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    return tail;
  } finally {
    await handle.close();
  }
}

export async function isZip(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return false;
  }
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    return bytesRead === 4 && magic.readUInt32LE(0) === LOCAL_SIGNATURE;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

export async function readCentralDirectory(path: string): Promise<ZipEntry[]> {
  // The EOCD sits at the very end unless a comment follows it; the comment
  // length is 16 bits, so 64 KiB plus the record is the whole search space.
  const tail = await readTail(path, 66 * 1024);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipError("no end-of-central-directory record — not a zip", path);

  const entryCount = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);

  if (directoryOffset === ZIP64_SENTINEL || entryCount === 0xffff) {
    throw new ZipError("zip64 archives are not supported; extract it yourself first", path);
  }

  const handle = await open(path, "r");
  let directory: Buffer;
  try {
    directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
  } finally {
    await handle.close();
  }

  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > directory.length) {
      throw new ZipError("central directory is truncated", path);
    }
    if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`central directory entry ${String(i)} has a bad signature`, path);
    }

    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);

    // Craig writes UTF-8 names, which is the whole reason this matters: a
    // Discord display name is the binding key for an entire audio track.
    const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength);

    if ((flags & 0x1) !== 0) {
      throw new ZipError(`entry "${name}" is encrypted`, path);
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipError(`entry "${name}" needs zip64; extract it yourself first`, path);
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  // Sorted by name so extraction order — and anything derived from it — does
  // not depend on how the archiver happened to lay the file out.
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Rejects paths that would land outside the destination. A crafted archive is
 * unlikely here, but "extract wherever the entry says" is how a download turns
 * into an arbitrary write.
 */
export function safeJoin(destination: string, name: string): string {
  const cleaned = normalize(name).replace(/^(?:[/\\]|\.\.(?:[/\\]|$))+/, "");
  if (cleaned === "" || cleaned === ".") {
    throw new ZipError(`entry "${name}" has no usable path`, destination);
  }
  const target = join(destination, cleaned);
  const root = destination.endsWith(sep) ? destination : destination + sep;
  if (!target.startsWith(root)) {
    throw new ZipError(`entry "${name}" escapes the extraction directory`, destination);
  }
  return target;
}

async function extractEntry(
  archive: string,
  entry: ZipEntry,
  destination: string,
): Promise<string> {
  // The local header repeats the name and extra fields at its own lengths,
  // which are allowed to differ from the central directory's.
  const handle = await open(archive, "r");
  let dataOffset: number;
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError(`entry "${entry.name}" has no local header`, archive);
    }
    dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }

  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new ZipError(
      `entry "${entry.name}" uses compression method ${String(entry.method)}, which is not supported`,
      archive,
    );
  }

  const target = safeJoin(destination, entry.name);
  await mkdir(dirname(target), { recursive: true });

  // An empty entry has no bytes at all, and createReadStream with `end` below
  // `start` reads to EOF rather than nothing.
  if (entry.compressedSize === 0) {
    await pipeline([Buffer.alloc(0)], createWriteStream(target));
    return target;
  }

  const source = createReadStream(archive, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });

  if (entry.method === STORED) {
    await pipeline(source, createWriteStream(target));
  } else {
    await pipeline(source, createInflateRaw(), createWriteStream(target));
  }
  return target;
}

/** Extracts every file entry, returning the written paths in entry order. */
export async function extractZip(archive: string, destination: string): Promise<string[]> {
  const entries = await readCentralDirectory(archive);
  const written: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      await mkdir(safeJoin(destination, entry.name), { recursive: true });
      continue;
    }
    written.push(await extractEntry(archive, entry, destination));
  }
  return written;
}
