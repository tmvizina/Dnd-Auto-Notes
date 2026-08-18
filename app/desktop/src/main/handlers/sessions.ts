import { existsSync, type Dirent } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createSession,
  loadRegistry,
  listStageRuns,
  Manifest as ManifestSchema,
  openDb,
  reindexAll,
  reindexSession,
  resolveSession,
  runIntakeStage,
  saveRegistry,
  suggestMappings,
  type Db,
  type IdentityKind,
  type IntakeStageResult,
  type Manifest,
  type Player,
  type SessionRow,
} from "@dnd/core";
import type {
  CopyProgressEvent,
  IntakeQaEntry,
  MappingSuggestion,
  SessionDropKind,
  SessionDropPaths,
  SessionSummary,
  SessionsCopyRequest,
  SessionsCopyResponse,
  SessionsCreateRequest,
  SessionsCreateResponse,
  SessionsGetRequest,
  SessionsGetResponse,
  SessionsListRequest,
  SessionsListResponse,
  SessionsMappingRequest,
  SessionsMappingResponse,
  SessionsQaRequest,
  SessionsQaResponse,
  SessionsRevealRequest,
  SessionsRevealResponse,
} from "../../shared/contracts.js";
import type { IpcHandlerMap } from "../ipc.js";

/** Options owned by the desktop composition root, kept injectable for tests. */
export interface SessionHandlersOptions {
  readonly sessionsRoot: string;
  readonly campaignRoot?: string;
  readonly databasePath?: string;
  readonly db?: Db;
  readonly emitCopyProgress?: (event: Omit<CopyProgressEvent, "sequence">) => void;
  readonly revealPath?: (path: string) => Promise<boolean>;
}

export interface SessionHandlers {
  readonly sessionsList: (request: SessionsListRequest) => Promise<SessionsListResponse>;
  readonly sessionsGet: (request: SessionsGetRequest) => Promise<SessionsGetResponse>;
  readonly sessionsCreate: (request: SessionsCreateRequest) => Promise<SessionsCreateResponse>;
  readonly sessionsCopy: (request: SessionsCopyRequest) => Promise<SessionsCopyResponse>;
  readonly sessionsReveal: (request: SessionsRevealRequest) => Promise<SessionsRevealResponse>;
  readonly sessionsQa: (request: SessionsQaRequest) => Promise<SessionsQaResponse>;
  readonly sessionsMapping: (request: SessionsMappingRequest) => Promise<SessionsMappingResponse>;
  /** Close the index only when this factory opened it. */
  readonly dispose: () => void;
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export type InputDropKind = SessionDropKind;

export interface InputCopyProgress {
  readonly bytesCopied: number;
  readonly totalBytes: number;
  readonly fraction: number;
}

export interface InputCopyOptions {
  readonly sessionRoot: string;
  readonly kind: InputDropKind;
  readonly sourcePath: string;
  readonly onProgress?: (progress: InputCopyProgress) => void;
}

export interface InputCopyResult {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly bytesCopied: number;
}

export interface SessionMappingDecision {
  readonly observed: string;
  readonly kind: IdentityKind;
  readonly playerId: string | null;
}

function defaultDatabasePath(sessionsRoot: string): string {
  return join(dirname(resolve(sessionsRoot)), "data", "notes.db");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 1_000;
  return Math.max(1, Math.min(1_000, Math.floor(limit)));
}

function offsetFromCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function latestStageStatus(db: Db, sessionId: string): string {
  return listStageRuns(db, sessionId)[0]?.status ?? "new";
}

async function manifestDuration(root: string): Promise<number | null> {
  const path = await safeSessionPath(
    root,
    join(root, "work", "01-intake", "manifest.json"),
    "work/01-intake/manifest.json",
  );
  try {
    const details = await stat(path);
    // A manifest is derived metadata, but a malformed or unexpectedly huge
    // one should never make the sessions list pull a large file into memory.
    if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const recording = (parsed as { recording?: unknown }).recording;
    if (typeof recording !== "object" || recording === null || Array.isArray(recording))
      return null;
    const duration = (recording as { duration_s?: unknown }).duration_s;
    return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
      ? duration
      : null;
  } catch {
    return null;
  }
}

function inputDirectory(sessionRoot: string, kind: InputDropKind): string {
  return join(resolve(sessionRoot), "input", kind);
}

function destinationName(sourcePath: string): string {
  const name =
    sourcePath
      .replace(/[\\/]+$/g, "")
      .split(/[\\/]/u)
      .at(-1) ?? "";
  if (name === "" || name === "." || name === ".." || name.includes("\0")) {
    throw new Error("dropped input does not have a safe file name");
  }
  return name;
}

function reportCopyProgress(
  callback: InputCopyOptions["onProgress"],
  bytesCopied: number,
  totalBytes: number,
): void {
  callback?.({
    bytesCopied,
    totalBytes,
    fraction: totalBytes === 0 ? 1 : Math.min(1, bytesCopied / totalBytes),
  });
}

/**
 * Stream one dropped input to its destination. The renderer receives only
 * counters, never audio bytes, so a multi-gigabyte file cannot accumulate in
 * the renderer heap or cross the IPC structured-clone limit.
 */
export async function copyInputFile(options: InputCopyOptions): Promise<InputCopyResult> {
  const sourcePath = resolve(options.sourcePath);
  const targetDirectory = await safeInputDirectory(options.sessionRoot, options.kind);
  const name = destinationName(sourcePath);
  const destinationPath = await safeSessionPath(
    options.sessionRoot,
    join(targetDirectory, name),
    `input/${options.kind}/${name}`,
  );
  if (sourcePath === resolve(destinationPath))
    throw new Error("input is already in the drop folder");

  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error("dropped input is not a regular file");
  await mkdir(targetDirectory, { recursive: true });

  const temporaryPath = await safeSessionPath(
    options.sessionRoot,
    join(targetDirectory, `.${name}.${randomUUID()}.partial`),
    `input/${options.kind}/${name}.partial`,
  );
  let copied = 0;
  reportCopyProgress(options.onProgress, 0, source.size);
  const progress = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : 0;
      copied += bytes;
      reportCopyProgress(options.onProgress, copied, source.size);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(sourcePath),
      progress,
      createWriteStream(temporaryPath, { flags: "wx" }),
    );
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Best effort cleanup; the original error is the actionable one.
    }
    throw error;
  }
  reportCopyProgress(options.onProgress, copied, source.size);
  return { sourcePath, destinationPath, bytesCopied: copied };
}

export async function copyInputFiles(
  options: Omit<InputCopyOptions, "sourcePath" | "onProgress"> & {
    readonly sourcePaths: readonly string[];
    readonly onProgress?: (index: number, total: number, progress: InputCopyProgress) => void;
  },
): Promise<readonly InputCopyResult[]> {
  const sourcePaths = [...options.sourcePaths];
  const results: InputCopyResult[] = [];
  for (const [index, sourcePath] of sourcePaths.entries()) {
    const result = await copyInputFile({
      ...options,
      sourcePath,
      onProgress: (progress) => options.onProgress?.(index, sourcePaths.length, progress),
    });
    results.push(result);
  }
  return results;
}

async function readBoundedJson(path: string): Promise<unknown | null> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) return null;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function asManifest(value: unknown): Manifest | null {
  // Reuse the canonical contract so malformed or partial files never leak
  // arbitrary values into a renderer response.
  const parsed = ManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function observedTrackName(path: string): string {
  const filename =
    path
      .replace(/[\\/]+$/g, "")
      .split(/[\\/]/u)
      .at(-1) ?? path;
  return filename.replace(/\.[^.]+$/u, "");
}

/** Return ranked suggestions from the identities that intake could not bind. */
export async function sessionMappingSuggestions(
  sessionRoot: string,
  campaignRoot = join(resolve(sessionRoot), "campaign"),
): Promise<ReturnType<typeof suggestMappings>> {
  const manifestPath = await safeSessionPath(
    sessionRoot,
    join(resolve(sessionRoot), "work", "01-intake", "manifest.json"),
    "work/01-intake/manifest.json",
  );
  const raw = await readBoundedJson(manifestPath);
  const manifest = asManifest(raw);
  if (manifest === null) return [];
  const registry = await loadRegistry(campaignRoot);
  const unmatched: Array<{ observed: string; kind: IdentityKind }> = [];
  const seen = new Set<string>();
  for (const track of manifest.tracks) {
    if (track.player_id !== null) continue;
    const observed = observedTrackName(track.path);
    const key = `discord:${observed}`;
    if (observed !== "" && !seen.has(key)) {
      seen.add(key);
      unmatched.push({ observed, kind: "discord" });
    }
  }
  for (const roll of manifest.rolls) {
    if (roll.player_id !== null) continue;
    const observed = roll.who?.trim() || roll.roll20_player_id?.trim() || "";
    const key = `roll20:${observed}`;
    if (observed !== "" && !seen.has(key)) {
      seen.add(key);
      unmatched.push({ observed, kind: "roll20" });
    }
  }
  unmatched.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.observed.localeCompare(right.observed),
  );
  return suggestMappings(registry, unmatched);
}

/** Apply only explicit user decisions and persist the campaign registry. */
export async function saveSessionMappings(
  campaignRoot: string,
  decisions: readonly SessionMappingDecision[],
): Promise<void> {
  const registry = await loadRegistry(campaignRoot);
  const seen = new Set<string>();
  for (const decision of decisions) {
    const key = `${decision.kind}:${decision.observed}`;
    if (seen.has(key)) throw new Error(`duplicate mapping decision for ${decision.observed}`);
    seen.add(key);
    if (decision.playerId === null) continue;
    const player = registry.players.find((candidate) => candidate.id === decision.playerId);
    if (player === undefined) throw new Error(`mapping target ${decision.playerId} does not exist`);
  }

  const players = registry.players.map((player) => {
    const decisionsForPlayer = decisions.filter((decision) => decision.playerId === player.id);
    let next: Player = player;
    for (const decision of decisionsForPlayer) {
      if (decision.kind === "discord") {
        const hints = next.discord.craig_track_hints.includes(decision.observed)
          ? next.discord.craig_track_hints
          : [...next.discord.craig_track_hints, decision.observed];
        next = { ...next, discord: { ...next.discord, craig_track_hints: hints } };
      } else {
        const account = next.roll20.account_name;
        const playerIds = next.roll20.player_ids.includes(decision.observed)
          ? next.roll20.player_ids
          : account === undefined
            ? next.roll20.player_ids
            : [...next.roll20.player_ids, decision.observed];
        next = {
          ...next,
          roll20:
            account === undefined
              ? { ...next.roll20, account_name: decision.observed, player_ids: playerIds }
              : { ...next.roll20, player_ids: playerIds },
        };
      }
    }
    return next;
  });
  await saveRegistry({ ...registry, players });
}

async function dropPaths(root: string): Promise<SessionDropPaths> {
  const [craig, roll20] = await Promise.all([
    safeInputDirectory(root, "craig"),
    safeInputDirectory(root, "roll20"),
  ]);
  return { craig, roll20 };
}

function contractSuggestions(
  suggestions: Awaited<ReturnType<typeof sessionMappingSuggestions>>,
): MappingSuggestion[] {
  return suggestions.map((suggestion) => ({
    observed: suggestion.observed,
    kind: suggestion.kind,
    exact: suggestion.exact,
    candidates: suggestion.candidates.map((candidate) => ({
      playerId: candidate.player_id,
      displayName: candidate.display_name,
      score: candidate.score,
      matchedOn: candidate.matched_on,
    })),
  }));
}

async function readIntakeQa(root: string): Promise<readonly IntakeQaEntry[]> {
  const manifestPath = await safeSessionPath(
    root,
    join(resolve(root), "work", "01-intake", "manifest.json"),
    "work/01-intake/manifest.json",
  );
  const raw = await readBoundedJson(manifestPath);
  const manifest = asManifest(raw);
  return (manifest?.qa ?? []).map((entry) => ({
    code: entry.code,
    severity: entry.severity,
    message: entry.message,
    ...(entry.subject === undefined ? {} : { subject: entry.subject }),
    ...(entry.hint === undefined ? {} : { hint: entry.hint }),
  }));
}

function rowRoot(row: SessionRow): string {
  return resolve(row.root_path);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isWithinOrEqualRoot(root: string, candidate: string): boolean {
  return resolve(root) === resolve(candidate) || isWithinRoot(root, candidate);
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    // A missing or unreadable root is not a session the renderer may access.
    return null;
  }
}

/**
 * Validate an existing or future descendant without trusting lexical path
 * prefixes. For a future file, realpath the nearest existing parent so a
 * symlink/junction anywhere in the path cannot redirect a write outside root.
 */
async function containedPath(root: string, candidate: string): Promise<string | null> {
  const canonicalRoot = await canonicalPath(root);
  if (canonicalRoot === null) return null;
  const resolvedCandidate = resolve(candidate);
  const canonicalCandidate = await canonicalPath(resolvedCandidate);
  if (canonicalCandidate !== null) {
    return isWithinRoot(canonicalRoot, canonicalCandidate) ? canonicalCandidate : null;
  }

  let nearestExisting = dirname(resolvedCandidate);
  while (true) {
    const canonicalParent = await canonicalPath(nearestExisting);
    if (canonicalParent !== null) {
      return isWithinOrEqualRoot(canonicalRoot, canonicalParent) ? resolvedCandidate : null;
    }
    const parent = dirname(nearestExisting);
    if (parent === nearestExisting) return null;
    nearestExisting = parent;
  }
}

async function safeSessionPath(
  root: string,
  candidate: string,
  description: string,
): Promise<string> {
  const safe = await containedPath(root, candidate);
  if (safe === null) throw new Error(`unsafe session path: ${description}`);
  return safe;
}

async function safeInputDirectory(sessionRoot: string, kind: InputDropKind): Promise<string> {
  return safeSessionPath(sessionRoot, inputDirectory(sessionRoot, kind), `input/${kind}`);
}

const SESSION_DERIVED_PATHS = [
  { relativePath: join("session.json"), description: "session.json" },
  { relativePath: join("session.md"), description: "session.md" },
  {
    relativePath: join("work", "01-intake", "manifest.json"),
    description: "work/01-intake/manifest.json",
  },
  {
    relativePath: join("work", "01-intake", "qa.json"),
    description: "work/01-intake/qa.json",
  },
  {
    relativePath: join("work", "02-transcript", "utterances.json"),
    description: "work/02-transcript/utterances.json",
  },
  {
    relativePath: join("work", "03-features", "features.json"),
    description: "work/03-features/features.json",
  },
  {
    relativePath: join("work", "03-features", "features.bin"),
    description: "work/03-features/features.bin",
  },
  {
    relativePath: join("work", "04-align", "timeline.json"),
    description: "work/04-align/timeline.json",
  },
  {
    relativePath: join("work", "05-persona", "attribution.json"),
    description: "work/05-persona/attribution.json",
  },
  {
    relativePath: join("work", "06-outline", "events.json"),
    description: "work/06-outline/events.json",
  },
  {
    relativePath: join("work", "07-notes", "qa.json"),
    description: "work/07-notes/qa.json",
  },
] as const;

/**
 * Core reindexing and stage writers follow filesystem links. Validate every
 * known artifact plus every stage metadata file before either operation can
 * observe a session tree, including links whose target file is not present.
 */
async function validateSessionDerivedPaths(sessionRoot: string): Promise<void> {
  const root = resolve(sessionRoot);
  const workPath = await safeSessionPath(root, join(root, "work"), "work");
  let workEntries: Dirent[];
  try {
    workEntries = await readdir(workPath, { withFileTypes: true });
  } catch {
    workEntries = [];
  }
  for (const entry of workEntries) {
    if (!entry.isDirectory()) continue;
    const stagePath = await safeSessionPath(root, join(workPath, entry.name), `work/${entry.name}`);
    await safeSessionPath(root, join(stagePath, "_stage.json"), `work/${entry.name}/_stage.json`);
  }
  for (const artifact of SESSION_DERIVED_PATHS) {
    await safeSessionPath(root, join(root, artifact.relativePath), artifact.description);
  }
}

/** Validate all physical session folders before core reindexAll scans them. */
async function validateSessionFolders(sessionsRoot: string): Promise<void> {
  const canonicalRoot = await canonicalPath(sessionsRoot);
  if (canonicalRoot === null) return;
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = await canonicalPath(join(sessionsRoot, entry.name));
    if (candidate === null || !isWithinRoot(canonicalRoot, candidate)) {
      throw new Error(`unsafe session path: ${entry.name}`);
    }
    await validateSessionDerivedPaths(candidate);
  }
}

async function sessionDescriptorRoot(
  row: SessionRow,
  sessionsRoot: string,
  canonicalSessionsRoot?: string | null,
): Promise<string | null> {
  const canonicalRoot = canonicalSessionsRoot ?? (await canonicalPath(sessionsRoot));
  if (canonicalRoot === null) return null;
  const canonicalCandidate = await canonicalPath(rowRoot(row));
  if (canonicalCandidate === null || !isWithinRoot(canonicalRoot, canonicalCandidate)) {
    return null;
  }
  return existsSync(join(canonicalCandidate, "session.json")) ? canonicalCandidate : null;
}

async function toSummary(
  db: Db,
  row: SessionRow,
  sessionsRoot: string,
  canonicalRoot?: string | null,
): Promise<SessionSummary> {
  const root = await sessionDescriptorRoot(row, sessionsRoot, canonicalRoot);
  if (root === null) throw new Error("session path is outside the sessions root");
  await validateSessionDerivedPaths(root);
  const stageStatus = latestStageStatus(db, row.session_id);
  return {
    sessionId: row.session_id,
    title: row.title,
    number: row.number,
    date: row.date,
    durationS: await manifestDuration(root),
    status: stageStatus === "new" ? row.status || "new" : stageStatus,
    grade: row.grade,
    hasNotes: existsSync(join(root, "session.md")),
  };
}

async function hasSessionDescriptor(
  row: SessionRow,
  sessionsRoot: string,
  canonicalRoot?: string | null,
): Promise<boolean> {
  return (await sessionDescriptorRoot(row, sessionsRoot, canonicalRoot)) !== null;
}

async function indexedSessionRoot(
  db: Db,
  sessionsRoot: string,
  sessionId: string,
): Promise<string | null> {
  const canonicalRoot = await canonicalPath(sessionsRoot);
  if (canonicalRoot === null) return null;
  await validateSessionFolders(sessionsRoot);
  await reindexAll(db, sessionsRoot);
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    SessionRow | undefined;
  if (row === undefined) return null;
  const root = await sessionDescriptorRoot(row, sessionsRoot, canonicalRoot);
  if (root !== null) await validateSessionDerivedPaths(root);
  return root;
}

async function listIndexedSessions(
  db: Db,
  sessionsRoot: string,
  request: SessionsListRequest,
): Promise<SessionsListResponse> {
  // The folder is the source of truth. Reindexing before every list makes a
  // session copied into the workspace outside the app visible immediately,
  // while the SQLite index still keeps the query bounded and ordered.
  const canonicalRoot = await canonicalPath(sessionsRoot);
  if (canonicalRoot === null) return { sessions: [] };
  await validateSessionFolders(sessionsRoot);
  await reindexAll(db, sessionsRoot);
  const status = request.status;
  const grade = request.grade;
  const filtered = db
    .prepare("SELECT * FROM sessions ORDER BY date DESC, session_id DESC")
    .all() as SessionRow[];
  const rows: SessionRow[] = [];
  for (const row of filtered) {
    if (
      (status === undefined || row.status === status) &&
      (grade === undefined || row.grade === grade) &&
      (await hasSessionDescriptor(row, sessionsRoot, canonicalRoot))
    ) {
      rows.push(row);
    }
  }
  const offset = offsetFromCursor(request.cursor);
  const limit = clampLimit(request.limit);
  const page = rows.slice(offset, offset + limit);
  const sessions: SessionSummary[] = [];
  for (const row of page) sessions.push(await toSummary(db, row, sessionsRoot, canonicalRoot));
  const nextOffset = offset + page.length;
  return {
    sessions,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

/**
 * Compose the three session IPC handlers. Main owns the long-lived index;
 * callers can inject one in tests and dispose only the connection created by
 * this factory.
 */
export function createSessionHandlers(options: SessionHandlersOptions): SessionHandlers {
  const sessionsRoot = resolve(options.sessionsRoot);
  const campaignRoot = resolve(options.campaignRoot ?? join(dirname(sessionsRoot), "campaign"));
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDb(options.databasePath ?? defaultDatabasePath(sessionsRoot));

  const sessionsList = async (request: SessionsListRequest): Promise<SessionsListResponse> =>
    listIndexedSessions(db, sessionsRoot, request);

  const sessionsGet = async ({ sessionId }: SessionsGetRequest): Promise<SessionsGetResponse> => {
    const canonicalRoot = await canonicalPath(sessionsRoot);
    if (canonicalRoot === null) return { session: null };
    await validateSessionFolders(sessionsRoot);
    await reindexAll(db, sessionsRoot);
    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      SessionRow | undefined;
    const root =
      row === undefined ? null : await sessionDescriptorRoot(row, sessionsRoot, canonicalRoot);
    if (root !== null) await validateSessionDerivedPaths(root);
    return {
      session:
        row === undefined || root === null
          ? null
          : await toSummary(db, row, sessionsRoot, canonicalRoot),
      ...(root === null ? {} : { paths: await dropPaths(root) }),
    };
  };

  const sessionsCreate = async (
    request: SessionsCreateRequest,
  ): Promise<SessionsCreateResponse> => {
    const created = await createSession(sessionsRoot, {
      title: request.title,
      date: request.date,
      number: request.number ?? null,
    });
    const craigInput = await safeInputDirectory(created.paths.root, "craig");
    const roll20Input = await safeInputDirectory(created.paths.root, "roll20");
    const clipsPath = await safeSessionPath(
      created.paths.root,
      created.paths.media("clips"),
      "media/clips",
    );
    await mkdir(craigInput, { recursive: true });
    await mkdir(roll20Input, { recursive: true });
    await mkdir(clipsPath, { recursive: true });
    await reindexSession(db, created.paths.root);
    const row = db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(created.descriptor.id) as SessionRow | undefined;
    if (row === undefined) throw new Error("created session was not indexed");
    return {
      session: await toSummary(db, row, sessionsRoot),
      paths: { craig: craigInput, roll20: roll20Input },
    };
  };

  const sessionsCopy = async ({
    sessionId,
    kind,
    sourcePath,
  }: SessionsCopyRequest): Promise<SessionsCopyResponse> => {
    const root = await indexedSessionRoot(db, sessionsRoot, sessionId);
    if (root === null) throw new Error("session was not found");
    const copyId = randomUUID();
    const result = await copyInputFile({
      sessionRoot: root,
      kind,
      sourcePath,
      onProgress: (progress) => {
        options.emitCopyProgress?.({
          type: "copy_progress",
          runId: copyId,
          kind,
          progress: progress.fraction,
          bytesCopied: progress.bytesCopied,
          totalBytes: progress.totalBytes,
        });
      },
    });
    return { copyId, destinationName: destinationName(result.destinationPath) };
  };

  const sessionsReveal = async ({
    sessionId,
    kind,
  }: SessionsRevealRequest): Promise<SessionsRevealResponse> => {
    const root = await indexedSessionRoot(db, sessionsRoot, sessionId);
    if (root === null) throw new Error("session was not found");
    if (options.revealPath === undefined) return { revealed: false };
    const directory = await safeInputDirectory(root, kind);
    return { revealed: await options.revealPath(directory) };
  };

  const sessionsQa = async ({ sessionId }: SessionsQaRequest): Promise<SessionsQaResponse> => {
    const root = await indexedSessionRoot(db, sessionsRoot, sessionId);
    if (root === null) throw new Error("session was not found");
    const entries = await readIntakeQa(root);
    let suggestions: MappingSuggestion[] = [];
    const selectedCampaignRoot = await resolveCampaignRoot(root, campaignRoot);
    try {
      suggestions = contractSuggestions(
        await sessionMappingSuggestions(root, selectedCampaignRoot),
      );
    } catch {
      // A missing campaign registry is itself represented by intake QA; the QA
      // page should remain readable while the mapping editor has no candidates.
    }
    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
      SessionRow | undefined;
    return { entries, grade: row?.grade ?? null, suggestions };
  };

  const sessionsMapping = async ({
    sessionId,
    decisions,
  }: SessionsMappingRequest): Promise<SessionsMappingResponse> => {
    const root = await indexedSessionRoot(db, sessionsRoot, sessionId);
    if (root === null) throw new Error("session was not found");
    await saveSessionMappings(await resolveCampaignRoot(root, campaignRoot), decisions);
    return { saved: true };
  };

  return {
    sessionsList,
    sessionsGet,
    sessionsCreate,
    sessionsCopy,
    sessionsReveal,
    sessionsQa,
    sessionsMapping,
    dispose: () => {
      if (ownsDb) db.close();
    },
  };
}

/** Adapt the richer factory result to the IPC handler map without dispose. */
export function asIpcSessionHandlers(handlers: SessionHandlers): IpcHandlerMap {
  return {
    sessionsList: (request) => handlers.sessionsList(request),
    sessionsGet: (request) => handlers.sessionsGet(request),
    sessionsCreate: (request) => handlers.sessionsCreate(request),
    sessionsCopy: (request) => handlers.sessionsCopy(request),
    sessionsReveal: (request) => handlers.sessionsReveal(request),
    sessionsQa: (request) => handlers.sessionsQa(request),
    sessionsMapping: (request) => handlers.sessionsMapping(request),
  };
}

/** Best-effort folder discovery for composition roots that need to refresh an index. */
export async function sessionFolders(sessionsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Resolve a pipeline target only after canonical containment is established. */
export async function resolvePipelineSessionRoot(
  sessionsRoot: string,
  sessionId: string,
): Promise<string> {
  const lexicalRoot = resolve(sessionsRoot);
  const canonicalRoot = await canonicalPath(lexicalRoot);
  if (canonicalRoot === null) throw new Error("session was not found");
  const candidate = await canonicalPath(join(lexicalRoot, sessionId));
  if (
    candidate === null ||
    !isWithinRoot(canonicalRoot, candidate) ||
    !existsSync(join(candidate, "session.json"))
  ) {
    throw new Error("session was not found");
  }
  await validateSessionDerivedPaths(candidate);
  return candidate;
}

export interface SessionIntakeOptions {
  readonly sessionRoot: string;
  readonly campaignRoot: string;
  readonly force: boolean;
  readonly onProgress?: (fraction: number, message: string) => void;
  readonly signal?: AbortSignal;
}

/** Use a safe session-local registry when present so mapping edits affect reruns. */
export async function resolveCampaignRoot(
  sessionRoot: string,
  configuredCampaignRoot: string,
): Promise<string> {
  const localCampaignRoot = join(resolve(sessionRoot), "campaign");
  if (existsSync(localCampaignRoot)) {
    const safeLocalRoot = await safeSessionPath(sessionRoot, localCampaignRoot, "campaign");
    if (
      existsSync(join(safeLocalRoot, "campaign.json")) ||
      existsSync(join(safeLocalRoot, "players.json"))
    ) {
      return safeLocalRoot;
    }
  }
  return resolve(configuredCampaignRoot);
}

/** Canonical stage entry point used by the desktop run handler. */
export async function runSessionIntake(options: SessionIntakeOptions): Promise<IntakeStageResult> {
  const sessionRoot = resolve(options.sessionRoot);
  await validateSessionDerivedPaths(sessionRoot);
  const session = await resolveSession(dirname(sessionRoot), basename(sessionRoot));
  if (session === null) throw new Error("session was not found");
  await safeInputDirectory(sessionRoot, "craig");
  await safeInputDirectory(sessionRoot, "roll20");
  return runIntakeStage({
    session,
    campaignRoot: await resolveCampaignRoot(sessionRoot, options.campaignRoot),
    force: options.force,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
