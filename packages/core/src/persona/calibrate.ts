import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VoiceProfile } from "./profileBank.js";

export type LabelMode = "in_character" | "out_of_character" | "narration" | "uncertain";

export interface LabelRecord {
  readonly utterance_id: string;
  readonly mode: LabelMode;
  readonly character_id: string | null;
  readonly labeller: string;
  readonly at: string;
  readonly session_id?: string;
  readonly player_id?: string | null;
  readonly features?: Readonly<Record<string, number>>;
  readonly embedding?: readonly number[];
}

export interface ThresholdResult {
  readonly threshold: number;
  readonly flagged_fraction: number;
  readonly error_rate: number;
}

export interface ProfileAccuracy {
  readonly accuracy: number | null;
  readonly evaluated: number;
}

export interface CalibrationReport {
  readonly label_count: number;
  readonly minimum: number;
  readonly precision: Record<string, number>;
  readonly recall: Record<string, number>;
  readonly f1: Record<string, number>;
  readonly threshold_sweep: readonly ThresholdResult[];
  readonly accuracy: number;
  readonly character_accuracy: number | null;
  readonly profile_accuracy_before: ProfileAccuracy;
  readonly profile_accuracy_after: ProfileAccuracy;
  readonly weights: Record<string, number>;
  readonly weights_by_class: Record<string, Record<string, number>>;
  readonly folds: number;
}

export interface ProfilePartitions {
  readonly training: readonly LabelRecord[];
  readonly held_out: readonly LabelRecord[];
}

export const MIN_LABELS = 20;
const DEFAULT_FOLDS = 5;
const REGULARIZATION = 0.01;
const LEARNING_RATE = 0.05;
const EPOCHS = 160;

/** Fractions of the least-confident labels the threshold sweep reviews. */
const SWEEP_FRACTIONS = [0.25, 0.5, 0.75] as const;

export function sampleLabels<
  T extends { utterance_id: string; player_id?: string | null; mode?: string; score?: number },
>(
  items: readonly T[],
  strategy: "uncertain" | "stratified" | "sequential",
  limit: number,
  labelled = new Set<string>(),
): T[] {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("label limit must be a non-negative integer");
  const fresh = items.filter((item) => !labelled.has(item.utterance_id));
  if (strategy === "sequential") return fresh.slice(0, limit);
  if (strategy === "uncertain")
    return [...fresh]
      .sort(
        (a, b) =>
          Math.abs((a.score ?? 0.5) - 0.5) - Math.abs((b.score ?? 0.5) - 0.5) ||
          stable(a.utterance_id, b.utterance_id),
      )
      .slice(0, limit);
  const groups = new Map<string, T[]>();
  for (const item of fresh) {
    const key = `${item.player_id ?? "unknown"}|${item.mode ?? "unknown"}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const total = fresh.length;
  const selected = new Map<string, number>();
  const out: T[] = [];
  while (out.length < limit && groups.size > 0) {
    const next = [...groups.entries()].sort(([leftKey, left], [rightKey, right]) => {
      const leftNeed =
        (limit * (left.length + (selected.get(leftKey) ?? 0))) / total -
        (selected.get(leftKey) ?? 0);
      const rightNeed =
        (limit * (right.length + (selected.get(rightKey) ?? 0))) / total -
        (selected.get(rightKey) ?? 0);
      return rightNeed - leftNeed || stable(leftKey, rightKey);
    })[0];
    if (next === undefined) break;
    const [key, group] = next;
    const item = group.shift();
    if (item !== undefined) {
      out.push(item);
      selected.set(key, (selected.get(key) ?? 0) + 1);
    }
    if (group.length === 0) groups.delete(key);
  }
  return out;
}

function stable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function readLabels(path: string): Promise<LabelRecord[]> {
  try {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as LabelRecord;
      } catch (error) {
        throw new Error(
          `invalid label record at line ${String(index + 1)}: ${(error as Error).message}`,
          { cause: error },
        );
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendLabels(path: string, records: readonly LabelRecord[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  if (records.length > 0)
    await appendFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
}

type Vector = readonly number[];
interface Model {
  readonly keys: readonly string[];
  readonly weights: readonly number[];
  readonly bias: number;
}

function featureKeys(labels: readonly LabelRecord[]): string[] {
  return [...new Set(labels.flatMap((label) => Object.keys(label.features ?? {})))].sort(stable);
}

function vector(label: LabelRecord, keys: readonly string[]): number[] {
  return keys.map((key) => {
    const value = label.features?.[key] ?? 0;
    if (!Number.isFinite(value))
      throw new Error(`feature ${key} is not finite for ${label.utterance_id}`);
    return value;
  });
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const e = Math.exp(-value);
    return 1 / (1 + e);
  }
  const e = Math.exp(value);
  return e / (1 + e);
}

function fitBinary(
  labels: readonly LabelRecord[],
  target: LabelMode,
  keys: readonly string[],
): Model {
  const weights = Array.from({ length: keys.length }, () => 0);
  let bias = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    for (const label of labels) {
      const values = vector(label, keys);
      const expected = label.mode === target ? 1 : 0;
      const probability = sigmoid(
        bias + values.reduce((sum, value, index) => sum + value * weights[index]!, 0),
      );
      const error = expected - probability;
      bias += LEARNING_RATE * error;
      for (let index = 0; index < weights.length; index += 1)
        weights[index] =
          (1 - LEARNING_RATE * REGULARIZATION) * weights[index]! +
          LEARNING_RATE * error * values[index]!;
    }
  }
  return { keys, weights, bias };
}

function probability(model: Model, label: LabelRecord): number {
  const values = vector(label, model.keys);
  return sigmoid(
    model.bias + values.reduce((sum, value, index) => sum + value * model.weights[index]!, 0),
  );
}

function classes(labels: readonly LabelRecord[]): LabelMode[] {
  return [...new Set(labels.map((label) => label.mode))].sort(stable) as LabelMode[];
}

function predict(
  models: ReadonlyMap<LabelMode, Model>,
  label: LabelRecord,
): { readonly mode: LabelMode; readonly confidence: number; readonly margin: number } {
  const scores = [...models.entries()].map(([mode, model]) => ({
    mode,
    score: probability(model, label),
  }));
  scores.sort((a, b) => b.score - a.score || stable(a.mode, b.mode));
  const best = scores[0];
  if (best === undefined) throw new Error("no calibration classes available");
  // Margin, not the winning probability, is what the rest of the pipeline
  // flags on (`match_min_margin` in the scorer, and the DM/NPC assignment).
  // The winning probability of k one-vs-rest models never drops below 1/k, so
  // sweeping it below that measures nothing.
  const runnerUp = scores[1];
  return {
    mode: best.mode,
    confidence: best.score,
    margin: runnerUp === undefined ? 1 : best.score - runnerUp.score,
  };
}

function foldsFor(labels: readonly LabelRecord[], count: number): LabelRecord[][] {
  const folds = Array.from({ length: count }, () => [] as LabelRecord[]);
  [...labels]
    .sort((a, b) => stable(a.utterance_id, b.utterance_id))
    .forEach((label, index) => folds[index % count]!.push(label));
  return folds;
}

function metrics(
  labels: readonly LabelRecord[],
  predictions: readonly LabelMode[],
  knownClasses: readonly LabelMode[],
): Pick<CalibrationReport, "precision" | "recall" | "f1" | "accuracy"> {
  const precision: Record<string, number> = {};
  const recall: Record<string, number> = {};
  const f1: Record<string, number> = {};
  for (const mode of knownClasses) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    labels.forEach((label, index) => {
      const actual = label.mode === mode;
      const predicted = predictions[index] === mode;
      if (actual && predicted) tp += 1;
      else if (!actual && predicted) fp += 1;
      else if (actual && !predicted) fn += 1;
    });
    precision[mode] = tp + fp === 0 ? 0 : tp / (tp + fp);
    recall[mode] = tp + fn === 0 ? 0 : tp / (tp + fn);
    f1[mode] =
      precision[mode]! + recall[mode]! === 0
        ? 0
        : (2 * precision[mode]! * recall[mode]!) / (precision[mode]! + recall[mode]!);
  }
  return {
    precision,
    recall,
    f1,
    accuracy:
      labels.length === 0
        ? 0
        : predictions.filter((prediction, index) => prediction === labels[index]!.mode).length /
          labels.length,
  };
}

function profileAccuracy(
  labels: readonly LabelRecord[],
  profiles: readonly VoiceProfile[],
): ProfileAccuracy {
  const usable = labels.filter(
    (label) =>
      label.character_id !== null && label.embedding !== undefined && label.embedding.length > 0,
  );
  if (usable.length === 0 || profiles.length === 0) return { accuracy: null, evaluated: 0 };
  let correct = 0;
  for (const label of usable) {
    const best =
      profiles.filter((profile) => profile.profile_id === label.character_id).length > 0
        ? profiles.find((profile) => profile.profile_id === label.character_id)
        : undefined;
    const nearest = profiles
      .map((profile) => ({ profile, similarity: cosine(label.embedding!, profile.centroid) }))
      .sort(
        (a, b) => b.similarity - a.similarity || stable(a.profile.profile_id, b.profile.profile_id),
      )[0]?.profile;
    if (best !== undefined && nearest?.profile_id === best.profile_id) correct += 1;
  }
  return { accuracy: correct / usable.length, evaluated: usable.length };
}

export function measureProfileAccuracy(
  labels: readonly LabelRecord[],
  profiles: readonly VoiceProfile[],
): ProfileAccuracy {
  return profileAccuracy(labels, profiles);
}

export function profilePartitions(labels: readonly LabelRecord[]): ProfilePartitions {
  const sessions = [
    ...new Set(
      labels
        .map((label) => label.session_id)
        .filter((session): session is string => session !== undefined),
    ),
  ].sort(stable);
  const heldOutSession = sessions.at(-1);
  const held_out =
    heldOutSession === undefined
      ? labels.slice(-Math.max(1, Math.floor(labels.length / DEFAULT_FOLDS)))
      : labels.filter((label) => label.session_id === heldOutSession);
  return { training: labels.filter((label) => !held_out.includes(label)), held_out };
}

function cosine(left: Vector, right: Vector): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? -1 : dot / Math.sqrt(leftNorm * rightNorm);
}

function profilesFromLabels(labels: readonly LabelRecord[]): VoiceProfile[] {
  const groups = new Map<string, LabelRecord[]>();
  for (const label of labels)
    if (label.character_id !== null && label.embedding !== undefined) {
      const key = label.character_id;
      groups.set(key, [...(groups.get(key) ?? []), label]);
    }
  return [...groups.entries()]
    .sort(([a], [b]) => stable(a, b))
    .map(([profileId, group]) => ({
      profile_id: profileId,
      centroid: group[0]!.embedding!.map(
        (_, index) =>
          group.reduce((sum, label) => sum + label.embedding![index]!, 0) / group.length,
      ),
      spread_radius: 0,
      example_utterance_count: group.length,
      sessions: [...new Set(group.map((label) => label.session_id ?? "unknown"))].sort(stable),
      version: 1,
    }));
}

function mergeProfiles(
  existing: readonly VoiceProfile[],
  seeded: readonly VoiceProfile[],
): VoiceProfile[] {
  const byId = new Map(existing.map((profile) => [profile.profile_id, profile]));
  for (const profile of seeded)
    if (!byId.has(profile.profile_id)) byId.set(profile.profile_id, profile);
  return [...byId.values()].sort((left, right) => stable(left.profile_id, right.profile_id));
}

export function calibrate(
  labels: readonly LabelRecord[],
  minimum = MIN_LABELS,
  existingProfiles: readonly VoiceProfile[] = [],
): CalibrationReport {
  if (labels.length < minimum)
    throw new Error(`need ${minimum - labels.length} more labels (minimum ${minimum})`);
  const knownClasses = classes(labels);
  const keys = featureKeys(labels);
  const foldCount = Math.min(DEFAULT_FOLDS, labels.length);
  const folds = foldsFor(labels, foldCount);
  const predictionById = new Map<
    string,
    { readonly mode: LabelMode; readonly confidence: number; readonly margin: number }
  >();
  for (const fold of folds) {
    const heldOut = new Set(fold.map((label) => label.utterance_id));
    const training = labels.filter((label) => !heldOut.has(label.utterance_id));
    const models = new Map(
      knownClasses.map(
        (mode) => [mode, fitBinary(training.length > 0 ? training : labels, mode, keys)] as const,
      ),
    );
    for (const label of fold) {
      const result = predict(models, label);
      predictionById.set(label.utterance_id, result);
    }
  }
  const ordered = [...labels].sort((a, b) => stable(a.utterance_id, b.utterance_id));
  const finalModels = new Map(
    knownClasses.map((mode) => [mode, fitBinary(labels, mode, keys)] as const),
  );
  const reportMetrics = metrics(
    ordered,
    ordered.map((label) => predictionById.get(label.utterance_id)?.mode ?? knownClasses[0]!),
    knownClasses,
  );
  // The sweep answers "if I hand-review the least confident N %, what error
  // rate is left in what I did not review?" — so it cuts by rank, not by a
  // fixed value. A fixed ladder cannot do this: the margins a given campaign
  // produces are unknown in advance, and a ladder that happens to sit below
  // all of them reports a flat, empty sweep that looks like a clean bill of
  // health. `threshold` is the margin at the cut, so it is still directly
  // usable as `match_min_margin`.
  const byMargin = [...ordered].sort(
    (a, b) =>
      (predictionById.get(a.utterance_id)?.margin ?? 1) -
        (predictionById.get(b.utterance_id)?.margin ?? 1) || stable(a.utterance_id, b.utterance_id),
  );
  const threshold_sweep = SWEEP_FRACTIONS.map((fraction) => {
    const take = Math.min(byMargin.length, Math.ceil(fraction * byMargin.length));
    const flagged = new Set(byMargin.slice(0, take).map((label) => label.utterance_id));
    const unflagged = ordered.filter((label) => !flagged.has(label.utterance_id));
    const errors = unflagged.filter(
      (label) => predictionById.get(label.utterance_id)?.mode !== label.mode,
    ).length;
    const cut = byMargin[take - 1];
    return {
      threshold:
        cut === undefined
          ? 0
          : Number((predictionById.get(cut.utterance_id)?.margin ?? 0).toFixed(6)),
      flagged_fraction: flagged.size / Math.max(1, ordered.length),
      error_rate: unflagged.length === 0 ? 0 : errors / unflagged.length,
    };
  });
  const weightsByClass = Object.fromEntries(
    [...finalModels.entries()].map(([mode, model]) => [
      mode,
      Object.fromEntries(model.keys.map((key, index) => [key, model.weights[index]!])),
    ]),
  );
  const firstModel = finalModels.get(knownClasses[0]!);
  const partitions = profilePartitions(labels);
  const afterProfiles = mergeProfiles(existingProfiles, profilesFromLabels(partitions.training));
  const beforeProfileAccuracy = profileAccuracy(partitions.held_out, existingProfiles);
  const afterProfileAccuracy = profileAccuracy(partitions.held_out, afterProfiles);
  return {
    label_count: labels.length,
    minimum,
    precision: reportMetrics.precision,
    recall: reportMetrics.recall,
    f1: reportMetrics.f1,
    threshold_sweep,
    accuracy: reportMetrics.accuracy,
    character_accuracy: afterProfileAccuracy.accuracy,
    profile_accuracy_before: beforeProfileAccuracy,
    profile_accuracy_after: afterProfileAccuracy,
    weights:
      firstModel === undefined
        ? {}
        : Object.fromEntries(
            firstModel.keys.map((key, index) => [key, firstModel.weights[index]!]),
          ),
    weights_by_class: weightsByClass,
    folds: foldCount,
  };
}

export async function writeCalibration(
  root: string,
  report: CalibrationReport,
  now = () => new Date().toISOString(),
): Promise<string> {
  await mkdir(root, { recursive: true });
  const stamp = now().replace(/[:.]/gu, "-");
  let path = join(root, `scorer-${stamp}.json`);
  let suffix = 1;
  while (true) {
    try {
      await readFile(path, "utf8");
      path = join(root, `scorer-${stamp}-${String(suffix++)}.json`);
    } catch {
      break;
    }
  }
  const version = path.slice(path.lastIndexOf("scorer-") + 7, -5);
  const payload = `${JSON.stringify({ ...report, version }, null, 2)}\n`;
  const temp = `${path}.${version}.tmp`;
  await writeFile(temp, payload, "utf8");
  await rename(temp, path);
  const activeTemp = join(root, `active.${version}.tmp`);
  await writeFile(activeTemp, `${JSON.stringify({ version, path }, null, 2)}\n`, "utf8");
  await rename(activeTemp, join(root, "active.json"));
  await appendFile(join(root, "calibration.log"), `${now()} ${JSON.stringify(report)}\n`, "utf8");
  return path;
}

export async function appendCalibrationDoc(
  path: string,
  report: CalibrationReport,
  date: string,
  session = "campaign",
): Promise<void> {
  const row = `\n| ${date} | ${session} | ${report.label_count} | ${report.accuracy.toFixed(4)} | ${(report.profile_accuracy_before.accuracy ?? 0).toFixed(4)} | ${(report.profile_accuracy_after.accuracy ?? 0).toFixed(4)} |\n`;
  try {
    await appendFile(path, row, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // ENOENT covers a missing *directory* as well as a missing file, and a
    // fresh campaign has neither — so the recovery has to create the folder
    // too, or the whole calibrate run exits 2 having done all the fitting.
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `# Calibration runs\n\n| date | session | labels | accuracy | profile before | profile after |\n| --- | --- | ---: | ---: | ---: | ---: |\n${row.slice(1)}`,
      "utf8",
    );
  }
}
