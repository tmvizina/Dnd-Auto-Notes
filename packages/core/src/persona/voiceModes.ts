export const MATCH_MIN_SIM = 0.78;
export const MATCH_MIN_MARGIN = 0.08;

export interface VoiceSample {
  readonly utterance_id: string;
  readonly player_id: string;
  readonly embedding: readonly number[];
  readonly prosody?: Readonly<Record<string, number>>;
  readonly duration_s?: number;
  readonly ooc_score?: number;
  readonly roll_proximity?: number;
}
export interface VoiceCluster {
  readonly id: string;
  readonly player_id: string;
  readonly utterance_ids: string[];
  readonly centroid: number[];
  readonly airtime_s: number;
  readonly table_score: number;
}
export interface ProfileCandidate {
  readonly profile_id: string;
  readonly similarity: number;
  readonly margin: number;
  readonly labelled: boolean;
}
export interface ColdStartResult {
  readonly matches: ProfileCandidate[];
  readonly qa: { code: "PERSONA_COLD_START"; severity: "info"; message: string };
}

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}
function cosine(left: readonly number[], right: readonly number[]): number {
  const n = norm(left) * norm(right);
  return n <= 0 ? 0 : left.reduce((sum, value, i) => sum + value * (right[i] ?? 0), 0) / n;
}
function mean(vectors: readonly (readonly number[])[]): number[] {
  return vectors[0] === undefined
    ? []
    : vectors[0].map(
        (_, i) => vectors.reduce((sum, vector) => sum + (vector[i] ?? 0), 0) / vectors.length,
      );
}

function representation(
  sample: VoiceSample,
  mode: "embedding" | "prosody" | "concatenated",
  weight: number,
): number[] {
  const prosody = Object.keys(sample.prosody ?? {})
    .sort()
    .map((key) => sample.prosody?.[key] ?? 0);
  if (mode === "embedding") return [...sample.embedding];
  if (mode === "prosody") return prosody;
  return [...sample.embedding, ...prosody.map((value) => value * weight)];
}

export function clusterVoiceModes(
  samples: readonly VoiceSample[],
  options: {
    readonly threshold?: number;
    readonly representation?: "embedding" | "prosody" | "concatenated";
    readonly prosodyWeight?: number;
  } = {},
): VoiceCluster[] {
  const threshold = options.threshold ?? 0.28;
  const mode = options.representation ?? "concatenated";
  const weight = options.prosodyWeight ?? 0.35;
  const groups = new Map<string, { ids: string[]; vectors: number[][]; samples: VoiceSample[] }>();
  for (const sample of [...samples].sort((a, b) => a.utterance_id.localeCompare(b.utterance_id))) {
    const group = groups.get(sample.player_id) ?? { ids: [], vectors: [], samples: [] };
    group.ids.push(sample.utterance_id);
    group.vectors.push(representation(sample, mode, weight));
    group.samples.push(sample);
    groups.set(sample.player_id, group);
  }
  const output: VoiceCluster[] = [];
  for (const [player, group] of groups) {
    const clusters = group.ids.map((id, i) => ({
      ids: [id],
      vectors: [group.vectors[i]!],
      samples: [group.samples[i]!],
    }));
    while (clusters.length > 1) {
      let best = { distance: Number.POSITIVE_INFINITY, left: -1, right: -1 };
      for (let left = 0; left < clusters.length; left += 1)
        for (let right = left + 1; right < clusters.length; right += 1) {
          const distance =
            1 - cosine(mean(clusters[left]!.vectors), mean(clusters[right]!.vectors));
          if (distance < best.distance) best = { distance, left, right };
        }
      if (best.distance > threshold) break;
      const right = clusters.splice(best.right, 1)[0]!;
      const left = clusters[best.left]!;
      left.ids.push(...right.ids);
      left.vectors.push(...right.vectors);
      left.samples.push(...right.samples);
    }
    clusters.sort((a, b) => a.ids[0]!.localeCompare(b.ids[0]!));
    clusters.forEach((cluster, index) => {
      const airtime = cluster.samples.reduce((sum, sample) => sum + (sample.duration_s ?? 0), 0);
      const score = cluster.samples.reduce(
        (sum, sample) =>
          sum +
          (sample.duration_s ?? 0) * (1 + (sample.ooc_score ?? 0) + (sample.roll_proximity ?? 0)),
        0,
      );
      output.push({
        id: `${player}:v${index + 1}`,
        player_id: player,
        utterance_ids: [...cluster.ids].sort(),
        centroid: mean(cluster.vectors),
        airtime_s: airtime,
        table_score: score,
      });
    });
  }
  return output.sort((a, b) => a.id.localeCompare(b.id));
}

export function identifyTableVoice(clusters: readonly VoiceCluster[]): VoiceCluster | null {
  return (
    [...clusters].sort((a, b) => b.table_score - a.table_score || a.id.localeCompare(b.id))[0] ??
    null
  );
}

export function matchClusterToProfiles(
  cluster: VoiceCluster,
  profiles: readonly { profile_id: string; centroid: readonly number[] }[],
  options: { minSimilarity?: number; minMargin?: number } = {},
): ProfileCandidate[] {
  const minSimilarity = options.minSimilarity ?? MATCH_MIN_SIM;
  const minMargin = options.minMargin ?? MATCH_MIN_MARGIN;
  const ranked = profiles
    .map((profile) => ({
      profile_id: profile.profile_id,
      similarity: cosine(cluster.centroid, profile.centroid),
      margin: 0,
      labelled: false,
    }))
    .sort((a, b) => b.similarity - a.similarity || a.profile_id.localeCompare(b.profile_id));
  return ranked.map((candidate, index) => {
    const margin = candidate.similarity - (ranked[index + 1]?.similarity ?? 0);
    return {
      ...candidate,
      margin,
      labelled: index === 0 && candidate.similarity >= minSimilarity && margin >= minMargin,
    };
  });
}
export function coldStart(clusters: readonly VoiceCluster[]): ColdStartResult {
  return {
    matches: clusters.map((cluster) => ({
      profile_id: cluster.id,
      similarity: 0,
      margin: 0,
      labelled: false,
    })),
    qa: {
      code: "PERSONA_COLD_START",
      severity: "info",
      message: `No voice profiles exist; ${clusters.length} cluster(s) require human review`,
    },
  };
}

export { cosine };
