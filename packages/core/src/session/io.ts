import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The filesystem operations artifact writing needs, injectable so the atomicity
 * guarantee can actually be tested by making one of them fail.
 */
export interface FileIo {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string | Uint8Array, encoding?: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export const nodeIo: FileIo = { mkdir, writeFile, rename, rm };

/**
 * Write via a sibling temp file and a rename, so a reader never observes a
 * half-written artifact and a crash leaves the previous version intact.
 * The temp file is a sibling rather than in the system temp dir because rename
 * is only atomic within a filesystem.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  io: FileIo = nodeIo,
): Promise<void> {
  const directory = dirname(filePath);
  await io.mkdir(directory, { recursive: true });

  const temp = join(directory, `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await io.writeFile(temp, contents, "utf8");
    await io.rename(temp, filePath);
  } catch (error) {
    // Best effort: if cleanup also fails the write error is the useful one.
    await io.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  io: FileIo = nodeIo,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, io);
}
