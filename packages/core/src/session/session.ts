import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ARTIFACTS } from "../contracts/artifacts.js";
import type { ArtifactName, ValidatedArtifactName } from "../contracts/artifacts.js";
import { ARTIFACT_SCHEMAS } from "../contracts/artifacts.js";
import { SessionId } from "../contracts/common.js";
import { writeJsonAtomic } from "./io.js";
import type { FileIo } from "./io.js";
import { sessionPaths } from "./paths.js";
import type { SessionPaths } from "./paths.js";

export const SessionDescriptor = z.object({
  id: SessionId,
  title: z.string().min(1),
  number: z.number().int().positive().nullable().default(null),
  date: z.string(),
  created_at: z.string(),
});
export type SessionDescriptor = z.infer<typeof SessionDescriptor>;

export interface Session {
  readonly descriptor: SessionDescriptor;
  readonly paths: SessionPaths;
}

export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly artifact: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

/** Slug that is safe as a directory name and stable across platforms. */
export function sessionIdFrom(date: string, title: string, index?: number): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Drop the combining marks NFKD just split off, or "é" becomes "e-".
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = index === undefined ? "" : `-${String(index)}`;
  return `${date}-${slug || "session"}${suffix}`;
}

export async function createSession(
  sessionsRoot: string,
  input: { title: string; date?: string; number?: number | null },
  io?: FileIo,
): Promise<Session> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const id = sessionIdFrom(date, input.title);
  const root = join(sessionsRoot, id);

  const descriptor: SessionDescriptor = {
    id,
    title: input.title,
    number: input.number ?? null,
    date,
    created_at: new Date().toISOString(),
  };

  await writeJsonAtomic(join(root, ARTIFACTS.session), descriptor, io);
  return { descriptor, paths: sessionPaths(root, id) };
}

/**
 * Accepts a session id, a path to a session folder, or `latest`. Returns null
 * rather than throwing so callers can phrase the error in their own terms.
 */
export async function resolveSession(
  sessionsRoot: string,
  idOrPath: string,
): Promise<Session | null> {
  if (idOrPath === "latest") {
    const entries = existsSync(sessionsRoot)
      ? (await readdir(sessionsRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];
    const newest = entries.at(-1);
    return newest === undefined ? null : resolveSession(sessionsRoot, newest);
  }

  const root = isAbsolute(idOrPath) ? resolve(idOrPath) : join(sessionsRoot, idOrPath);
  const descriptorPath = join(root, ARTIFACTS.session);
  if (!existsSync(descriptorPath)) return null;

  const parsed = SessionDescriptor.safeParse(
    JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new ArtifactError(
      `session.json is not a valid session descriptor: ${describeIssues(parsed.error)}`,
      "session",
      descriptorPath,
    );
  }
  return { descriptor: parsed.data, paths: sessionPaths(root, parsed.data.id) };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export async function readArtifact<K extends ValidatedArtifactName>(
  session: Session,
  name: K,
): Promise<z.infer<(typeof ARTIFACT_SCHEMAS)[K]>> {
  const path = session.paths.artifact(name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ArtifactError(`artifact "${name}" has not been written yet`, name, path);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new ArtifactError(
      `artifact "${name}" is not valid JSON: ${(error as Error).message}`,
      name,
      path,
    );
  }

  const result = ARTIFACT_SCHEMAS[name].safeParse(parsedJson);
  if (!result.success) {
    throw new ArtifactError(
      `artifact "${name}" does not match its contract — ${describeIssues(result.error)}`,
      name,
      path,
    );
  }
  return result.data as z.infer<(typeof ARTIFACT_SCHEMAS)[K]>;
}

/** Validates before writing: an invalid artifact never reaches disk. */
export async function writeArtifact<K extends ValidatedArtifactName>(
  session: Session,
  name: K,
  value: unknown,
  io?: FileIo,
): Promise<z.infer<(typeof ARTIFACT_SCHEMAS)[K]>> {
  const path = session.paths.artifact(name);
  const result = ARTIFACT_SCHEMAS[name].safeParse(value);
  if (!result.success) {
    throw new ArtifactError(
      `refusing to write artifact "${name}" — ${describeIssues(result.error)}`,
      name,
      path,
    );
  }
  await writeJsonAtomic(path, result.data, io);
  return result.data as z.infer<(typeof ARTIFACT_SCHEMAS)[K]>;
}

export function artifactExists(session: Session, name: ArtifactName): boolean {
  return existsSync(session.paths.artifact(name));
}
