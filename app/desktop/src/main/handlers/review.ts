import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  ReviewBulkRequest,
  ReviewBulkResponse,
  ReviewClipRequest,
  ReviewClipResponse,
  ReviewFlag,
  ReviewListRequest,
  ReviewListResponse,
  ReviewResolveRequest,
  ReviewResolveResponse,
  ReviewRevertRequest,
  ReviewRevertResponse,
  ReviewRerunRequest,
  ReviewRerunResponse,
} from "../../shared/contracts.js";
import type { IpcHandlerMap } from "../ipc.js";

interface ReviewIo {
  readonly readFile: typeof readFile;
  readonly writeFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  readonly rename: typeof rename;
  readonly mkdir: typeof mkdir;
  readonly unlink: typeof unlink;
}
const nativeIo: ReviewIo = { readFile, writeFile, rename, mkdir, unlink };

export interface ReviewHandlersOptions {
  readonly sessionsRoot: string;
  readonly campaignRoot: string;
  readonly io?: ReviewIo;
  readonly extractClip?: (sessionId: string, utteranceId: string) => Promise<string>;
  readonly rerun?: (sessionId: string, utteranceIds: readonly string[]) => Promise<string>;
  readonly updateProfile?: (
    sessionId: string,
    utteranceId: string,
    characterId: string | null,
  ) => Promise<string | undefined>;
  readonly revertProfile?: (sessionId: string, journalId: string) => Promise<void>;
  readonly findProfileJournal?: (
    sessionId: string,
    utteranceId: string,
  ) => Promise<string | undefined>;
  readonly maxCachedClips?: number;
}

interface StoredAttribution {
  utterance_id: string;
  mode: string;
  character_id: string | null;
  confidence?: number;
  flags?: readonly { code: string; reason: string }[];
  evidence?: Readonly<Record<string, unknown>>;
  cluster_id?: string | null;
  speaker?: string;
  text?: string;
  start_s?: number;
  duration_s?: number;
  candidates?: readonly { label: string; character_id: string | null; score: number }[];
}
interface StoredArtifact {
  readonly attributions?: readonly StoredAttribution[];
}

function artifactPath(options: ReviewHandlersOptions, sessionId: string): string {
  return join(options.sessionsRoot, sessionId, "work", "05-persona", "attribution.json");
}
function labelsPath(options: ReviewHandlersOptions, sessionId: string): string {
  return join(options.campaignRoot, "labels", `${sessionId}.jsonl`);
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
function safeId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field} has an invalid format`);
}
function contained(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
async function assertSessionPath(options: ReviewHandlersOptions, sessionId: string): Promise<void> {
  if (options.io !== undefined) return;
  const root = await realpath(options.sessionsRoot);
  const session = await realpath(join(options.sessionsRoot, sessionId));
  if (!contained(root, session)) throw new Error("session path escaped sessions directory");
}
async function load(
  options: ReviewHandlersOptions,
  sessionId: string,
  recoverReceipts = true,
): Promise<StoredAttribution[]> {
  safeId(sessionId, "sessionId");
  await assertSessionPath(options, sessionId).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("ENOENT")) return;
    throw error;
  });
  try {
    if (options.io === undefined && recoverReceipts) {
      const artifact = artifactPath(options, sessionId);
      const names = await readdir(dirname(artifact));
      for (const name of names.filter((item) => item.endsWith(".bulk-review-receipt.json"))) {
        try {
          const receipt = JSON.parse(await readFile(join(dirname(artifact), name), "utf8")) as {
            previousArtifact?: string;
            previousLabels?: string;
            journalIds?: readonly string[];
          };
          if (receipt.previousArtifact !== undefined)
            await writeFile(artifact, receipt.previousArtifact, "utf8");
          if (receipt.previousLabels !== undefined) {
            const labels = labelsPath(options, sessionId);
            await mkdir(dirname(labels), { recursive: true });
            await writeFile(labels, receipt.previousLabels, "utf8");
          }
          for (const journalId of receipt.journalIds ?? [])
            await options.revertProfile?.(sessionId, journalId);
          await unlink(join(dirname(artifact), name));
        } catch {
          /* preserve the receipt until the next recovery attempt */
        }
      }
      for (const name of names.filter((item) => item.endsWith(".review-receipt.json"))) {
        try {
          const receipt = JSON.parse(await readFile(join(dirname(artifact), name), "utf8")) as {
            previousArtifact?: string;
            previousLabels?: string;
            journalId?: string;
            utteranceId?: string;
          };
          if (receipt.previousArtifact !== undefined)
            await writeFile(artifact, receipt.previousArtifact, "utf8");
          if (receipt.previousLabels !== undefined) {
            const labels = labelsPath(options, sessionId);
            await mkdir(dirname(labels), { recursive: true });
            await writeFile(labels, receipt.previousLabels, "utf8");
          }
          const journalId =
            receipt.journalId ??
            (receipt.utteranceId === undefined
              ? undefined
              : await options.findProfileJournal?.(sessionId, receipt.utteranceId));
          if (journalId !== undefined) await options.revertProfile?.(sessionId, journalId);
          await unlink(join(dirname(artifact), name));
        } catch {
          /* retain the receipt for a later recovery attempt */
        }
      }
    }
    const parsed: unknown = JSON.parse(
      await (options.io ?? nativeIo).readFile(artifactPath(options, sessionId), "utf8"),
    );
    const rows: readonly StoredAttribution[] =
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as StoredArtifact).attributions)
        ? ((parsed as StoredArtifact).attributions ?? [])
        : [];
    return rows.filter(
      (row): row is StoredAttribution =>
        typeof row?.utterance_id === "string" &&
        typeof row.mode === "string" &&
        (row.character_id === null || typeof row.character_id === "string"),
    );
  } catch {
    return [];
  }
}
function toFlag(row: StoredAttribution, index: number): ReviewFlag | null {
  const flag = row.flags?.[0];
  if (flag === undefined) return null;
  return {
    utteranceId: row.utterance_id,
    code: flag.code,
    impactS: Math.max(0, 1 - (row.confidence ?? 0)) * (row.duration_s ?? 1),
    timestampS: row.start_s ?? index,
    speaker: row.speaker ?? "Unknown speaker",
    text: row.text ?? "",
    candidates: (row.candidates ?? []).map((candidate) => ({
      label: candidate.label,
      characterId: candidate.character_id,
      score: candidate.score,
    })),
    evidence: row.evidence ?? {},
    clusterId: row.cluster_id ?? null,
  };
}
async function atomicWrite(
  options: ReviewHandlersOptions,
  sessionId: string,
  rows: readonly StoredAttribution[],
): Promise<void> {
  const io = options.io ?? nativeIo;
  const path = artifactPath(options, sessionId);
  const temp = `${path}.${randomUUID()}.tmp`;
  await io.mkdir(join(path, ".."), { recursive: true });
  try {
    await io.writeFile(temp, `${JSON.stringify({ attributions: rows }, null, 2)}\n`, "utf8");
    await io.rename(temp, path);
  } catch (error) {
    await io.unlink(temp).catch(() => undefined);
    throw error;
  }
}
async function atomicLabels(
  options: ReviewHandlersOptions,
  sessionId: string,
  previous: string,
  line: string,
): Promise<void> {
  const io = options.io ?? nativeIo;
  const path = labelsPath(options, sessionId);
  const temp = `${path}.${randomUUID()}.tmp`;
  await io.mkdir(join(options.campaignRoot, "labels"), { recursive: true });
  try {
    await io.writeFile(temp, `${previous}${line}`, "utf8");
    await io.rename(temp, path);
  } catch (error) {
    await io.unlink(temp).catch(() => undefined);
    throw error;
  }
}
function applied(row: StoredAttribution, request: ReviewResolveRequest): StoredAttribution {
  const mode =
    request.action === "out_of_character"
      ? "out_of_character"
      : request.action === "unresolvable"
        ? "uncertain"
        : (request.label ?? "in_character");
  return {
    ...row,
    mode,
    character_id:
      request.action === "character" || request.action === "candidate"
        ? (request.characterId ?? null)
        : null,
    flags: (row.flags ?? []).filter(
      (flag) =>
        flag.code !== "persona_ambiguous" &&
        flag.code !== "unknown_npc" &&
        flag.code !== "uncertain",
    ),
  };
}
async function resolveOne(
  options: ReviewHandlersOptions,
  request: ReviewResolveRequest,
  recoverReceipts = true,
): Promise<ReviewResolveResponse> {
  safeId(request.sessionId, "sessionId");
  safeId(request.utteranceId, "utteranceId");
  const rows = await load(options, request.sessionId, recoverReceipts);
  const index = rows.findIndex((row) => row.utterance_id === request.utteranceId);
  if (index < 0) throw new Error("review utterance was not found");
  const row = rows[index];
  if (row === undefined) throw new Error("review utterance was not found");
  const next = applied(row, request);
  const io = options.io ?? nativeIo;
  const artifact = artifactPath(options, request.sessionId);
  const previousArtifact = await io.readFile(artifact, "utf8");
  let previousLabels = "";
  try {
    previousLabels = await io.readFile(labelsPath(options, request.sessionId), "utf8");
  } catch {
    /* first label */
  }
  let journalId: string | undefined;
  const receipt = `${artifact}.${request.utteranceId}.review-receipt.json`;
  try {
    await io.writeFile(
      receipt,
      JSON.stringify({
        sessionId: request.sessionId,
        utteranceId: request.utteranceId,
        previousArtifact,
        previousLabels,
      }),
      "utf8",
    );
    journalId =
      request.characterId === undefined || options.updateProfile === undefined
        ? undefined
        : await options.updateProfile(request.sessionId, request.utteranceId, request.characterId);
    await io.writeFile(
      receipt,
      JSON.stringify({
        sessionId: request.sessionId,
        utteranceId: request.utteranceId,
        previousArtifact,
        previousLabels,
        journalId,
      }),
      "utf8",
    );
    await atomicWrite(
      options,
      request.sessionId,
      rows.map((item, i) => (i === index ? next : item)),
    );
    await atomicLabels(
      options,
      request.sessionId,
      previousLabels,
      `${JSON.stringify({ utterance_id: request.utteranceId, mode: next.mode, character_id: next.character_id })}\n`,
    );
    await io.unlink(receipt).catch(() => undefined);
  } catch (error) {
    let rollbackError: unknown;
    try {
      const rollback = `${artifact}.${randomUUID()}.rollback`;
      await io.writeFile(rollback, previousArtifact, "utf8");
      await io.rename(rollback, artifact);
      await atomicLabels(options, request.sessionId, previousLabels, "");
    } catch (caught) {
      rollbackError = caught;
    }
    if (journalId !== undefined) await options.revertProfile?.(request.sessionId, journalId);
    if (rollbackError !== undefined)
      throw new Error(`review rollback failed: ${String(rollbackError)}`, { cause: error });
    throw error;
  }
  return {
    saved: true,
    rerunSuggested: journalId !== undefined,
    ...(journalId === undefined ? {} : { journalId }),
  };
}
export interface ReviewHandlers {
  readonly reviewList: (request: ReviewListRequest) => Promise<ReviewListResponse>;
  readonly reviewResolve: (request: ReviewResolveRequest) => Promise<ReviewResolveResponse>;
  readonly reviewBulk: (request: ReviewBulkRequest) => Promise<ReviewBulkResponse>;
  readonly reviewRevert: (request: ReviewRevertRequest) => Promise<ReviewRevertResponse>;
  readonly reviewRerun: (request: ReviewRerunRequest) => Promise<ReviewRerunResponse>;
  readonly reviewClip: (request: ReviewClipRequest) => Promise<ReviewClipResponse>;
}
export function createReviewHandlers(options: ReviewHandlersOptions): ReviewHandlers {
  const clipCache = new Map<string, string>();
  const maxCachedClips = Math.max(1, options.maxCachedClips ?? 8);
  return {
    reviewList: async (request) => {
      safeId(request.sessionId, "sessionId");
      const rows = await load(options, request.sessionId);
      return {
        flags: rows
          .map(toFlag)
          .filter((flag): flag is ReviewFlag => flag !== null)
          .sort((a, b) => b.impactS - a.impactS || a.timestampS - b.timestampS),
      };
    },
    reviewResolve: (request) => resolveOne(options, request),
    reviewBulk: async (request) => {
      safeId(request.sessionId, "sessionId");
      const rows = await load(options, request.sessionId);
      const members = rows.filter(
        (row) => request.clusterId === (row.cluster_id ?? row.utterance_id),
      );
      let count = 0;
      let rerunSuggested = false;
      const io = options.io ?? nativeIo;
      const artifact = artifactPath(options, request.sessionId);
      const beforeArtifact = await io.readFile(artifact, "utf8");
      let beforeLabels = "";
      try {
        beforeLabels = await io.readFile(labelsPath(options, request.sessionId), "utf8");
      } catch {
        /* first bulk */
      }
      const journals: string[] = [];
      const bulkReceipt = `${artifact}.${request.clusterId}.bulk-review-receipt.json`;
      await io.writeFile(
        bulkReceipt,
        JSON.stringify({
          sessionId: request.sessionId,
          clusterId: request.clusterId,
          previousArtifact: beforeArtifact,
          previousLabels: beforeLabels,
          members: members.map((row) => row.utterance_id),
        }),
        "utf8",
      );
      try {
        for (const row of members) {
          const result = await resolveOne(
            options,
            {
              sessionId: request.sessionId,
              utteranceId: row.utterance_id,
              action: request.action,
              ...(request.label === undefined ? {} : { label: request.label }),
              ...(request.characterId === undefined ? {} : { characterId: request.characterId }),
            },
            false,
          );
          if (result.journalId !== undefined) journals.push(result.journalId);
          await io.writeFile(
            bulkReceipt,
            JSON.stringify({
              previousArtifact: beforeArtifact,
              previousLabels: beforeLabels,
              journalIds: journals,
            }),
            "utf8",
          );
          count += 1;
          rerunSuggested ||= result.rerunSuggested;
        }
        await io.unlink(bulkReceipt).catch(() => undefined);
      } catch (error) {
        let rollbackComplete = true;
        try {
          await io.writeFile(artifact, beforeArtifact, "utf8");
          await atomicLabels(options, request.sessionId, beforeLabels, "");
          for (const journalId of journals)
            await options.revertProfile?.(request.sessionId, journalId);
        } catch {
          rollbackComplete = false;
        }
        if (rollbackComplete) await io.unlink(bulkReceipt).catch(() => undefined);
        throw error;
      }
      return { saved: true, count, rerunSuggested };
    },
    reviewRevert: async (request) => {
      safeId(request.sessionId, "sessionId");
      if (options.revertProfile === undefined) return { reverted: false };
      await options.revertProfile(request.sessionId, request.journalId);
      return { reverted: true };
    },
    reviewRerun: async (request) => {
      safeId(request.sessionId, "sessionId");
      return {
        runId:
          options.rerun === undefined
            ? `review-${request.sessionId}`
            : await options.rerun(request.sessionId, request.utteranceIds),
      };
    },
    reviewClip: async (request) => {
      safeId(request.sessionId, "sessionId");
      safeId(request.utteranceId, "utteranceId");
      const io = options.io ?? nativeIo;
      const root = join(options.sessionsRoot, request.sessionId, "media", "clips");
      const cached = join(root, `${request.utteranceId}.wav`);
      const cacheKey = `${request.sessionId}/${request.utteranceId}`;
      const existing = clipCache.get(cacheKey);
      if (existing !== undefined) return { path: existing };
      const path =
        options.extractClip === undefined
          ? cached
          : await options.extractClip(request.sessionId, request.utteranceId);
      if (!contained(root, path)) throw new Error("clip path escaped session clip directory");
      if (options.io === undefined) {
        const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
        if (!contained(canonicalRoot, canonicalPath))
          throw new Error("clip symlink escaped session clip directory");
      }
      clipCache.delete(cacheKey);
      clipCache.set(cacheKey, path);
      while (clipCache.size > maxCachedClips) {
        const oldest = clipCache.keys().next().value;
        if (oldest === undefined) break;
        const evicted = clipCache.get(oldest);
        clipCache.delete(oldest);
        if (evicted !== undefined) await io.unlink(evicted).catch(() => undefined);
      }
      return { path };
    },
  };
}
export function asIpcReviewHandlers(handlers: ReviewHandlers): IpcHandlerMap {
  return handlers;
}
