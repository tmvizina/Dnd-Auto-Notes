import { dirname, join } from "node:path";
import { appendFile, mkdir, readFile as readFileNative, rm, writeFile } from "node:fs/promises";
import {
  readArtifact,
  readFeatureEmbedding,
  readLabels,
  sampleLabels,
  type LabelRecord,
} from "@dnd/core";
import type { Session } from "@dnd/core";
export interface LabelChoiceInput {
  readonly utterance_id: string;
  readonly text: string;
  readonly features: Readonly<Record<string, number>>;
  readonly embedding?: readonly number[];
  readonly clip: { readonly path: string; readonly start_s: number; readonly end_s: number };
}
export interface LabelCommandOptions {
  readonly session: Session;
  readonly campaignRoot: string;
  readonly strategy?: "uncertain" | "stratified" | "sequential";
  readonly limit?: number;
  readonly labeller?: string;
  readonly relabel?: boolean;
  readonly now?: () => string;
  readonly choose?: (
    item: LabelChoiceInput,
  ) => Promise<{ mode: LabelRecord["mode"]; character_id: string | null }>;
  readonly play?: (clip: LabelChoiceInput["clip"]) => Promise<void>;
  readonly io?: LabelFileIo;
}

export interface LabelFileIo {
  readonly appendFile: (path: string, data: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
}

const nativeLabelIo: LabelFileIo = {
  appendFile: async (path, data) => appendFile(path, data, "utf8"),
  readFile: async (path) => readFileNative(path, "utf8"),
  writeFile: async (path, data) => writeFile(path, data, "utf8"),
  mkdir: async (path) => mkdir(path, { recursive: true }).then(() => undefined),
  rm: async (path) => rm(path, { force: true }),
};

interface LabelReceipt {
  readonly version: 1;
  readonly files: readonly { readonly path: string; readonly previous: string | null }[];
}

async function recoverLabelReceipt(
  io: LabelFileIo,
  marker: string,
  expectedPaths: readonly string[],
): Promise<void> {
  let receipt: LabelReceipt;
  try {
    receipt = JSON.parse(await io.readFile(marker)) as LabelReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("label publication receipt is corrupt; manual recovery is required", {
      cause: error,
    });
  }
  if (
    receipt.version !== 1 ||
    !Array.isArray(receipt.files) ||
    receipt.files.some(
      (file) =>
        typeof file.path !== "string" ||
        (file.previous !== null && typeof file.previous !== "string"),
    ) ||
    receipt.files.length !== expectedPaths.length ||
    receipt.files.some((file) => !expectedPaths.includes(file.path))
  )
    throw new Error("label publication receipt is invalid; manual recovery is required");
  for (const file of receipt.files) {
    if (file.previous === null) await io.rm(file.path);
    else await io.writeFile(file.path, file.previous);
  }
  await io.rm(marker);
}

export class LabelUsageError extends Error {
  readonly code = "LABEL_USAGE";
}

function numericFeatures(
  value: Readonly<Record<string, unknown>> | undefined,
  prefix = "",
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
      .map(([key, item]) => [`${prefix}${key}`, item as number]),
  );
}

export async function labelSession(
  options: LabelCommandOptions,
): Promise<{ selected: number; skipped: number; path: string }> {
  if (
    options.strategy !== undefined &&
    !["uncertain", "stratified", "sequential"].includes(options.strategy)
  )
    throw new LabelUsageError("--strategy must be uncertain, stratified, or sequential");
  if (
    options.limit !== undefined &&
    (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit <= 0)
  )
    throw new LabelUsageError("--minutes must be a positive finite number");
  const path = join(options.campaignRoot, "labels", `${options.session.descriptor.id}.jsonl`);
  const allPath = join(options.campaignRoot, "labels", "all.jsonl");
  const io = options.io ?? nativeLabelIo;
  const receiptPath = join(options.campaignRoot, "labels", ".label-publication-receipt.json");
  await recoverLabelReceipt(io, receiptPath, [path, allPath]);
  const existing = await readLabels(path);
  const labelled = new Set(existing.map((record) => record.utterance_id));
  const transcript = await readArtifact(options.session, "transcript");
  const attribution = await readArtifact(options.session, "attribution").catch(() => null);
  const features = await readArtifact(options.session, "features").catch(() => null);
  const embeddingPath =
    features === null
      ? null
      : join(dirname(options.session.paths.artifact("features")), features.embedding.blob);
  const items = await Promise.all(
    transcript.utterances.map(async (item) => {
      const featureRow = features?.rows.find((row) => row.utterance_id === item.id);
      const attributionRow = attribution?.attributions.find((row) => row.utterance_id === item.id);
      const featureValues = {
        ...numericFeatures(
          attributionRow?.evidence as Readonly<Record<string, unknown>> | undefined,
          "evidence.",
        ),
        ...numericFeatures(
          featureRow?.prosody_z as Readonly<Record<string, unknown>> | undefined,
          "prosody_z.",
        ),
      };
      const embedding =
        featureRow?.offset === null ||
        featureRow === undefined ||
        embeddingPath === null ||
        features === null
          ? undefined
          : await readFeatureEmbedding(
              embeddingPath,
              featureRow.offset,
              features.embedding.dimension,
            );
      return {
        utterance_id: item.id,
        player_id: item.player_id,
        mode: attributionRow?.mode ?? "uncertain",
        score: attributionRow?.confidence ?? 0.5,
        text: item.text,
        features: featureValues,
        clip: {
          path: options.session.paths.media("clips", `${item.id}.wav`),
          start_s: 0,
          end_s: item.end_s - item.start_s,
        },
        ...(embedding === undefined ? {} : { embedding }),
      };
    }),
  );
  const selected = sampleLabels(
    items,
    options.strategy ?? "uncertain",
    options.limit ?? 15,
    options.relabel === true ? new Set() : labelled,
  );
  const now = options.now ?? (() => new Date().toISOString());
  const records: LabelRecord[] = [];
  for (const item of selected) {
    await options.play?.(item.clip);
    const choice = await options.choose?.(item);
    if (choice === undefined) throw new LabelUsageError("interactive label choice is required");
    records.push({
      utterance_id: item.utterance_id,
      mode: choice.mode,
      character_id: choice.character_id,
      player_id: item.player_id,
      session_id: options.session.descriptor.id,
      labeller: options.labeller ?? "unknown",
      at: now(),
      features: item.features,
      ...(item.embedding === undefined ? {} : { embedding: item.embedding }),
    });
  }
  const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const snapshots = await Promise.all(
    [path, allPath].map(async (file) => {
      try {
        return { file, value: await io.readFile(file) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, value: null };
        throw error;
      }
    }),
  );
  try {
    await io.mkdir(join(options.campaignRoot, "labels"));
    await io.writeFile(
      receiptPath,
      `${JSON.stringify({
        version: 1,
        files: snapshots.map(({ file, value }) => ({ path: file, previous: value })),
      })}\n`,
    );
    await io.appendFile(path, payload);
    await io.appendFile(allPath, payload);
    await io.rm(receiptPath);
  } catch (error) {
    let rollbackError: unknown;
    for (const { file, value } of snapshots) {
      try {
        if (value === null) await io.rm(file);
        else await io.writeFile(file, value);
      } catch (caught) {
        rollbackError ??= caught;
      }
    }
    if (rollbackError === undefined) await io.rm(receiptPath).catch(() => undefined);
    if (rollbackError !== undefined)
      throw new Error("label publication rollback failed; retry the command to recover", {
        cause: error,
      });
    throw error;
  }
  return { selected: records.length, skipped: existing.length, path };
}
