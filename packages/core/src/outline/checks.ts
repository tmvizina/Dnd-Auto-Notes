import type { Check } from "../contracts/events.js";
import type { OutlineEvent } from "./events.js";

export interface CheckOptions {
  readonly intent_window_s?: number;
  readonly adjudication_window_s?: number;
  readonly attempt_gap_s?: number;
  readonly glossary?: readonly string[];
  readonly npc_ids?: readonly string[];
}

export interface CheckAttempt {
  readonly check: Check;
  readonly group_id: string;
  readonly attempt_index: number;
  readonly intent_source: string | null;
  readonly adjudication_source: string | null;
}

export interface CandidateThread {
  readonly kind: "promise" | "stake";
  readonly text: string;
  readonly source: string;
}

export interface CheckScene {
  readonly checks: readonly CheckAttempt[];
  readonly participants: readonly string[];
  readonly npcs: readonly string[];
  readonly topic: string | null;
  readonly outcome: "agreement" | "refusal" | "transition" | "unknown";
  readonly threads: readonly CandidateThread[];
  readonly unassigned_rolls: readonly { readonly roll_id: string; readonly reason: string }[];
}

interface Speech {
  readonly event: OutlineEvent;
  readonly text: string;
}

function stable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function speeches(events: readonly OutlineEvent[]): Speech[] {
  return events
    .filter((event) => event.kind === "speech" && event.text !== undefined)
    .map((event) => ({ event, text: event.text ?? "" }))
    .sort((a, b) => a.event.t_start_s - b.event.t_start_s || stable(a.event.id, b.event.id));
}

function field(raw: string | undefined, name: string): string | null {
  if (raw === undefined) return null;
  const match = raw.match(new RegExp(`(?:^|[;|,\\s])${name}\\s*[:=]\\s*([^;|,]+)`, "iu"));
  return match?.[1]?.trim() || null;
}

function skillFor(raw: string | undefined): string {
  return field(raw, "skill") ?? field(raw, "ability") ?? "unknown";
}

function precedingSpeech(
  list: readonly Speech[],
  time: number,
  window: number,
): Speech | undefined {
  return list
    .filter((item) => item.event.t_end_s <= time && time - item.event.t_end_s <= window)
    .sort((a, b) => b.event.t_end_s - a.event.t_end_s || stable(a.event.id, b.event.id))[0];
}

function followingDm(list: readonly Speech[], time: number, window: number): Speech | undefined {
  return list
    .filter(
      (item) =>
        item.event.is_dm && item.event.t_start_s >= time && item.event.t_start_s - time <= window,
    )
    .sort((a, b) => a.event.t_start_s - b.event.t_start_s || stable(a.event.id, b.event.id))[0];
}

function verdict(text: string | undefined): Check["verdict"] {
  if (text === undefined) return "unknown";
  if (/\b(?:fail(?:s|ed|ure)?|miss(?:es|ed)?)\b/iu.test(text)) return "failure";
  // Stems rather than a hand-listed set: the list here omitted the bare
  // "succeed", so "You succeed" — the single most common way a DM says it —
  // came back as an unknown verdict.
  if (/\b(?:succeed(?:s|ed)?|success|pass(?:es|ed)?|made it|works)\b/iu.test(text))
    return "success";
  return "unknown";
}

function normalizedSubject(text: string | null): string {
  return (text ?? "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function topicFor(list: readonly Speech[], glossary: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const term of glossary) {
    if (term.trim() === "") continue;
    const count = list.filter((item) =>
      item.text.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
    ).length;
    if (count >= 2) counts.set(term, count);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || stable(a[0], b[0]))[0]?.[0] ?? null;
}

function outcomeFor(
  list: readonly Speech[],
  events: readonly OutlineEvent[],
): CheckScene["outcome"] {
  const text = list.map((item) => item.text).join(" ");
  // Refusal is tested first because a refusal usually names the thing being
  // refused: "the guard refuses the deal" contains an agreement keyword and is
  // the opposite of an agreement. Negation has to win the tie.
  if (/\b(?:refus(?:e|es|ed|al)|no deal|reject(?:s|ed)?|won't|will not)\b/iu.test(text))
    return "refusal";
  if (/\b(?:agree(?:s|d)?|deal|done|accept(?:s|ed)?)\b/iu.test(text)) return "agreement";
  if (
    /\b(?:we move on|let's move on|scene shifts|combat begins|initiative begins)\b/iu.test(text) ||
    events.some((item) => item.kind === "combat_start")
  )
    return "transition";
  return "unknown";
}

function threadsFor(list: readonly Speech[]): CandidateThread[] {
  const result: CandidateThread[] = [];
  for (const item of list) {
    const promise = item.text.match(/\b(?:we'?ll|i'?ll|we will|i will)\b[^.!?]{2,120}/iu);
    if (promise?.[0] !== undefined)
      result.push({
        kind: "promise",
        text: promise[0].trim(),
        source: item.event.source_refs.utterances[0] ?? item.event.id,
      });
    const stake = item.text.match(/\b(?:pay|reward|price|if|unless)\b[^.!?]{2,120}/iu);
    if (stake?.[0] !== undefined)
      result.push({
        kind: "stake",
        text: stake[0].trim(),
        source: item.event.source_refs.utterances[0] ?? item.event.id,
      });
  }
  return result;
}

function subjectTokens(value: string): Set<string> {
  return new Set(value.split(/\s+/u).filter((token) => token.length >= 4));
}

/** Extracts explicit checks and nearby social-scene evidence without inventing DCs or verdicts. */
export function reconstructChecks(
  events: readonly OutlineEvent[],
  options: CheckOptions = {},
): CheckScene {
  const ordered = [...events].sort((a, b) => a.t_start_s - b.t_start_s || stable(a.id, b.id));
  const speech = speeches(ordered);
  const intentWindow = options.intent_window_s ?? 12;
  const adjudicationWindow = options.adjudication_window_s ?? 12;
  const attemptGap = options.attempt_gap_s ?? 90;
  const checks: CheckAttempt[] = [];
  const unassigned: { roll_id: string; reason: string }[] = [];
  const participants = new Set<string>();
  const npcIds = new Set(options.npc_ids ?? []);
  const npcs = new Set<string>();
  for (const event of ordered) {
    if (event.speaker_character_id !== null && npcIds.has(event.speaker_character_id))
      npcs.add(event.speaker_character_id);
  }
  const lastBySkill = new Map<
    string,
    { time: number; group: string; index: number; subject: string }
  >();
  for (const event of ordered) {
    for (const roll of event.rolls) {
      if (roll.kind !== "check") continue;
      const actor = event.speaker_character_id;
      if (actor !== null) participants.add(actor);
      if (actor !== null && npcIds.has(actor)) npcs.add(actor);
      const intent = precedingSpeech(speech, event.t_start_s, intentWindow);
      const adjudication = followingDm(speech, event.t_end_s, adjudicationWindow);
      const subject = normalizedSubject(intent?.text ?? null);
      const key = `${actor ?? "unknown"}|${skillFor(roll.raw_ref)}`;
      const previous = lastBySkill.get(key);
      const overlap = [...subjectTokens(subject)].some((token) =>
        subjectTokens(previous?.subject ?? "").has(token),
      );
      const same =
        previous !== undefined &&
        event.t_start_s - previous.time <= attemptGap &&
        (subject === previous.subject || overlap || subject === "" || previous.subject === "");
      const group = same ? previous.group : `check-${String(checks.length + 1).padStart(4, "0")}`;
      const index = same ? previous.index + 1 : 1;
      lastBySkill.set(key, { time: event.t_start_s, group, index, subject });
      checks.push({
        check: {
          actor,
          skill: skillFor(roll.raw_ref),
          total: roll.total,
          roll_id: roll.id,
          stated_intent: intent?.text ?? null,
          verdict: verdict(adjudication?.text),
        },
        group_id: group,
        attempt_index: index,
        intent_source: intent?.event.source_refs.utterances[0] ?? null,
        adjudication_source: adjudication?.event.source_refs.utterances[0] ?? null,
      });
    }
  }
  for (const event of ordered) {
    for (const roll of event.rolls) {
      if (roll.kind !== "check") continue;
      if (!checks.some((item) => item.check.roll_id === roll.id))
        unassigned.push({ roll_id: roll.id, reason: "check could not be reconstructed" });
    }
  }
  return {
    checks,
    participants: [...participants].sort(stable),
    npcs: [...npcs].sort(stable),
    topic: topicFor(speech, options.glossary ?? []),
    outcome: outcomeFor(speech, ordered),
    threads: threadsFor(speech),
    unassigned_rolls: unassigned,
  };
}

export const buildChecks = reconstructChecks;
