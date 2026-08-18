export const NPC_WINDOW_S = 45;
export interface DmUtterance {
  readonly id: string;
  readonly player_id: string | null;
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
  readonly mode?: "in_character" | "narration" | "out_of_character";
  readonly voice_cluster?: string;
}
export interface NpcEvidence {
  readonly character_id: string;
  readonly score: number;
  readonly reasons: string[];
}
export interface DmNpcResult {
  readonly utterance_id: string;
  readonly mode: "narration" | "npc" | "skipped";
  readonly character_id: string | null;
  readonly voice_cluster?: string;
  readonly candidates: NpcEvidence[];
  readonly flags: string[];
}
export interface NpcProfile {
  readonly character_id: string;
  readonly voice_cluster?: string;
  readonly aliases?: readonly string[];
  readonly owner_type?: "npc" | "pc";
}
export interface DmContext {
  readonly utterances: readonly DmUtterance[];
  readonly profiles?: readonly NpcProfile[];
  readonly npc_names?: readonly string[];
  readonly roll_mentions?: readonly { name: string; t_audio_s: number }[];
  readonly margin?: number;
  readonly window_s?: number;
}

const quote = /"[^"]+"|“[^”]+”|‘[^’]+’/u;
const narration =
  /^(the|a|an)\s|\b(he|she|they|it)\s+(was|were|is|are|had|has|walked|looked|said|stood)\b|\b(says?|asks?|shouts?)\s*[:,]/iu;
const direct = /\b(i|me|my|we|our|you|your)\b/iu;
function names(text: string, known: readonly string[]): string[] {
  return known.filter((name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(text),
  );
}

export function classifyDmMode(text: string): "narration" | "npc" {
  return quote.test(text) || (direct.test(text) && !narration.test(text)) ? "npc" : "narration";
}

export function assignDmNpcs(context: DmContext): DmNpcResult[] {
  const npcProfiles = (context.profiles ?? []).filter((profile) => profile.owner_type === "npc");
  const namesKnown =
    context.npc_names ??
    npcProfiles.flatMap((profile) => [profile.character_id, ...(profile.aliases ?? [])]);
  const discovered = new Set(namesKnown);
  const margin = context.margin ?? 1.5;
  const window = context.window_s ?? NPC_WINDOW_S;
  let active: { name: string; at: number } | null = null;
  let previous: { name: string; at: number } | null = null;
  const output: DmNpcResult[] = [];
  for (const utterance of [...context.utterances].sort(
    (a, b) => a.start_s - b.start_s || a.id.localeCompare(b.id),
  )) {
    if (utterance.player_id !== null) {
      output.push({
        utterance_id: utterance.id,
        mode: "skipped",
        character_id: null,
        candidates: [],
        flags: ["not_dm"],
      });
      continue;
    }
    if (utterance.mode === "out_of_character") {
      output.push({
        utterance_id: utterance.id,
        mode: "skipped",
        character_id: null,
        candidates: [],
        flags: ["out_of_character"],
      });
      continue;
    }
    const mode =
      utterance.mode === "narration"
        ? "narration"
        : utterance.mode === "in_character"
          ? "npc"
          : classifyDmMode(utterance.text);
    const stop = new Set([
      "The",
      "A",
      "An",
      "He",
      "She",
      "They",
      "It",
      "I",
      "We",
      "You",
      "Go",
      "Sure",
      "Pay",
    ]);
    const proper =
      mode === "narration"
        ? [...utterance.text.matchAll(/\b[A-Z][a-z]{2,}\b/gu)]
            .map((match) => match[0]!)
            .filter((name) => !stop.has(name))
        : [];
    for (const name of proper) discovered.add(name);
    const mentioned = names(utterance.text, [...discovered]);
    if (
      mentioned.length &&
      (mode === "narration" || mentioned.some((name) => namesKnown.includes(name)))
    )
      active = { name: mentioned[0]!, at: utterance.start_s };
    if (mode === "narration") {
      output.push({
        utterance_id: utterance.id,
        mode,
        character_id: null,
        candidates: [],
        flags: [],
      });
      continue;
    }
    const scores = new Map<string, NpcEvidence>();
    for (const profile of npcProfiles)
      scores.set(profile.character_id, {
        character_id: profile.character_id,
        score: profile.voice_cluster && profile.voice_cluster === utterance.voice_cluster ? 3 : 0,
        reasons: profile.voice_cluster === utterance.voice_cluster ? ["voice_bank"] : [],
      });
    if (active && utterance.start_s - active.at <= window) {
      const decay = Math.max(0, 1 - (utterance.start_s - active.at) / window);
      const existing = scores.get(active.name) ?? {
        character_id: active.name,
        score: 0,
        reasons: [],
      };
      scores.set(active.name, {
        ...existing,
        score: existing.score + 8 * decay,
        reasons: [...existing.reasons, "name_window"],
      });
    }
    if (previous && utterance.start_s - previous.at <= window) {
      const intervening = context.utterances.filter(
        (item) =>
          item.player_id !== null &&
          item.start_s > previous!.at &&
          item.start_s < utterance.start_s,
      ).length;
      const decay =
        intervening > 0 ? 0 : Math.max(0, 1 - (utterance.start_s - previous.at) / window);
      const existing = scores.get(previous.name) ?? {
        character_id: previous.name,
        score: 0,
        reasons: [],
      };
      scores.set(previous.name, {
        ...existing,
        score: existing.score + decay,
        reasons: [...existing.reasons, "continuity"],
      });
    }
    for (const mention of context.roll_mentions ?? [])
      if (
        mention.t_audio_s >= utterance.start_s - window &&
        mention.t_audio_s <= utterance.end_s + window
      ) {
        const existing = scores.get(mention.name) ?? {
          character_id: mention.name,
          score: 0,
          reasons: [],
        };
        scores.set(mention.name, {
          ...existing,
          score: existing.score + 2,
          reasons: [...existing.reasons, "roll_mention"],
        });
      }
    const adjacencyWindow = 3;
    for (const adjacent of context.utterances)
      if (
        adjacent.player_id !== null &&
        (Math.abs(adjacent.end_s - utterance.start_s) <= adjacencyWindow ||
          Math.abs(adjacent.start_s - utterance.end_s) <= adjacencyWindow)
      ) {
        const intervening = context.utterances.some(
          (item) =>
            item.id !== adjacent.id &&
            item.id !== utterance.id &&
            item.start_s >= adjacent.end_s &&
            item.end_s <= utterance.start_s,
        );
        if (!intervening)
          for (const name of names(adjacent.text, [...discovered])) {
            const existing = scores.get(name) ?? { character_id: name, score: 0, reasons: [] };
            scores.set(name, {
              ...existing,
              score: existing.score + 4,
              reasons: [...existing.reasons, "direct_address"],
            });
          }
      }
    const candidates = [...scores.values()].sort(
      (a, b) => b.score - a.score || a.character_id.localeCompare(b.character_id),
    );
    const winner = candidates[0];
    const runner = candidates[1];
    const confident =
      winner !== undefined &&
      winner.score > 0 &&
      (runner === undefined || winner.score - runner.score >= margin);
    const trusted = namesKnown.includes(winner?.character_id ?? "");
    if (confident && trusted) {
      previous = { name: winner.character_id, at: utterance.start_s };
      output.push({
        utterance_id: utterance.id,
        mode,
        character_id: winner.character_id,
        ...(utterance.voice_cluster === undefined
          ? {}
          : { voice_cluster: utterance.voice_cluster }),
        candidates,
        flags: [],
      });
    } else {
      output.push({
        utterance_id: utterance.id,
        mode,
        character_id: null,
        ...(utterance.voice_cluster === undefined
          ? {}
          : { voice_cluster: utterance.voice_cluster }),
        candidates,
        flags: ["unknown_npc"],
      });
    }
  }
  return output;
}

export function proposeNewNpcs(
  results: readonly DmNpcResult[],
  namesKnown: readonly string[],
): { character_id: string; voice_cluster: string; evidence: string; proposal: true }[] {
  const counts = new Map<string, { count: number; cluster: string }>();
  for (const result of results)
    for (const candidate of result.candidates)
      if (
        result.character_id === null &&
        result.flags.includes("unknown_npc") &&
        result.voice_cluster &&
        candidate.reasons.some((reason) => reason === "name_window" || reason === "direct_address")
      ) {
        const key = `${result.voice_cluster}|${candidate.character_id}`;
        const prior = counts.get(key);
        counts.set(key, { count: (prior?.count ?? 0) + 1, cluster: result.voice_cluster });
      }
  return [...counts.entries()]
    .filter(([key, value]) => value.count >= 2 && !namesKnown.includes(key.split("|")[1]!))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => ({
      character_id: key.split("|")[1]!,
      voice_cluster: value.cluster,
      evidence: "recurring unlabeled DM voice cluster with repeated nearby name evidence",
      proposal: true,
    }));
}
