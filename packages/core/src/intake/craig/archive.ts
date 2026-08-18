import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashFile } from "../../stage/hash.js";
import { writeJsonAtomic } from "../../session/io.js";
import { isTrackFile } from "./names.js";
import { extractZip } from "./zip.js";

/**
 * Craig hands back a zip. Extracting it is the most expensive thing intake
 * does — gigabytes of FLAC — so it happens exactly once and is remembered by
 * the archive's own hash. Re-running the stage on an unchanged download must
 * cost nothing, or the "just re-run it" habit the rest of the pipeline depends
 * on becomes too expensive to have.
 */

export const EXTRACTED_DIRNAME = "extracted";

/** Sits inside the extraction so deleting the folder also forgets the receipt. */
export const RECEIPT_FILENAME = ".craig-archive.json";

export interface ExtractionReceipt {
  readonly archive: string;
  readonly sha256: string;
  readonly extracted_at: string;
  readonly files: string[];
}

export interface Extraction {
  /** Directory the track files live in — the extraction, or `input/craig` itself. */
  readonly trackRoot: string;
  /** Basename of the archive, or null when the tracks were already loose. */
  readonly archive: string | null;
  readonly sha256: string | null;
  /** False when a valid extraction was already on disk. */
  readonly extracted: boolean;
}

async function readReceipt(path: string): Promise<ExtractionReceipt | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ExtractionReceipt;
  } catch {
    return null;
  }
}

/**
 * The largest zip in the folder. Craig only ever writes one, but a human who
 * downloaded twice should get the real recording rather than a stray
 * `chat-export.zip` that happened to sort first.
 */
export async function findArchive(craigDir: string): Promise<string | null> {
  if (!existsSync(craigDir)) return null;
  const entries = await readdir(craigDir, { withFileTypes: true });
  const zips = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
    .map((entry) => entry.name)
    .sort();
  if (zips.length === 0) return null;

  let largest = zips[0] ?? null;
  let largestSize = -1;
  for (const name of zips) {
    const { size } = await stat(join(craigDir, name));
    if (size > largestSize) {
      largestSize = size;
      largest = name;
    }
  }
  return largest;
}

async function hasTrackFiles(directory: string): Promise<boolean> {
  if (!existsSync(directory)) return false;
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && isTrackFile(entry.name));
}

/**
 * Extracts the archive if there is one and it has not already been extracted
 * from this exact set of bytes. Loose tracks are left exactly where they are.
 */
export async function ensureExtracted(craigDir: string): Promise<Extraction> {
  const archive = await findArchive(craigDir);
  if (archive === null) {
    return { trackRoot: craigDir, archive: null, sha256: null, extracted: false };
  }

  const archivePath = join(craigDir, archive);
  const destination = join(craigDir, EXTRACTED_DIRNAME);
  const receiptPath = join(destination, RECEIPT_FILENAME);
  const sha256 = await hashFile(archivePath);

  const receipt = await readReceipt(receiptPath);
  // The hash is the whole test. A re-download with the same bytes is the same
  // recording; different bytes are a different recording wearing the same name.
  if (receipt?.sha256 === sha256 && (await hasTrackFiles(destination))) {
    return { trackRoot: destination, archive, sha256, extracted: false };
  }

  // A stale extraction is removed rather than merged into: leftovers from a
  // previous download would appear as extra participants.
  if (existsSync(destination)) await rm(destination, { recursive: true, force: true });

  const written = await extractZip(archivePath, destination);
  await writeJsonAtomic(receiptPath, {
    archive,
    sha256,
    extracted_at: new Date().toISOString(),
    files: written.map((path) => basename(path)).sort(),
  } satisfies ExtractionReceipt);

  return { trackRoot: destination, archive, sha256, extracted: true };
}
