import type { Encounter, Turn } from "../contracts/events.js";
import type { OutlineEvent } from "./events.js";

export interface EncounterOptions {
  /** Maps Roll20 names to canonical character/NPC ids when the registry resolved them. */
  readonly actorByName?: Readonly<Record<string, string>>;
  readonly narration_window_s?: number;
}

interface RollOccurrence {
  readonly id: string;
  readonly time: number;
  readonly actor: string | null;
  readonly actorName: string;
  readonly roll: OutlineEvent["rolls"][number];
}
function targetFor(roll: RollOccurrence["roll"]): string | null {
  const match = roll.raw_ref?.match(/(?:target|against)\s*[:=]\s*([A-Za-z0-9 _-]+)/iu);
  return match?.[1]?.trim() || null;
}

interface TurnState {
  readonly round: number;
  readonly actor: string | null;
  readonly actorName: string;
  readonly time: number;
  rollIds: string[];
  rollEvidence: Turn["roll_evidence"];
  narration: string[];
  damage: number;
}

function stable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function actorName(event: OutlineEvent, roll: OutlineEvent["rolls"][number]): string {
  return event.character_display ?? event.speaker_display ?? roll.who;
}

function actorId(
  event: OutlineEvent,
  roll: OutlineEvent["rolls"][number],
  options: EncounterOptions,
): string | null {
  return event.speaker_character_id ?? options.actorByName?.[actorName(event, roll)] ?? null;
}

function occurrences(events: readonly OutlineEvent[], options: EncounterOptions): RollOccurrence[] {
  const seen = new Set<string>();
  const out: RollOccurrence[] = [];
  for (const event of [...events].sort((a, b) => a.t_start_s - b.t_start_s || stable(a.id, b.id))) {
    for (const roll of event.rolls) {
      if (seen.has(roll.id)) throw new Error(`roll ${roll.id} occurs more than once`);
      seen.add(roll.id);
      out.push({
        id: roll.id,
        time: event.t_start_s,
        actor: actorId(event, roll, options),
        actorName: actorName(event, roll),
        roll,
      });
    }
  }
  return out;
}

function trackerAt(events: readonly OutlineEvent[], time: number) {
  return [...events]
    .filter((event) => event.turnorder !== undefined && event.t_start_s <= time)
    .sort((a, b) => a.t_start_s - b.t_start_s || a.turnorder!.seq - b.turnorder!.seq)
    .at(-1)?.turnorder;
}

function orderNames(entries: readonly { readonly name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

function addTurn(turns: TurnState[], occurrence: RollOccurrence, round: number): TurnState {
  const existing = turns.find(
    (turn) => turn.round === round && turn.actorName === occurrence.actorName,
  );
  if (existing !== undefined) return existing;
  const turn: TurnState = {
    round,
    actor: occurrence.actor,
    actorName: occurrence.actorName,
    time: occurrence.time,
    rollIds: [],
    rollEvidence: [],
    narration: [],
    damage: 0,
  };
  turns.push(turn);
  return turn;
}

function evidence(occurrence: RollOccurrence): Turn["roll_evidence"][number] {
  const critical = occurrence.roll.dice.some(
    (die) => die.sides === 20 && (die.value === 20 || die.value === 1),
  );
  return {
    roll_id: occurrence.roll.id,
    seq: occurrence.roll.seq,
    who: occurrence.roll.who,
    player_id: occurrence.roll.player_id,
    formula: occurrence.roll.formula,
    modifiers: occurrence.roll.modifiers,
    kind: occurrence.roll.kind,
    advantage: occurrence.roll.advantage,
    total: occurrence.roll.total,
    target: targetFor(occurrence.roll),
    ...(occurrence.roll.raw_ref === undefined ? {} : { raw_ref: occurrence.roll.raw_ref }),
    dice: occurrence.roll.dice,
    critical,
  };
}

function finalizeTurn(turn: TurnState): Turn {
  return {
    actor: turn.actor,
    roll_ids: [...turn.rollIds],
    roll_evidence: [...turn.rollEvidence],
    narration_utterances: [...turn.narration],
    damage_total: turn.damage === 0 ? null : turn.damage,
  };
}

/** Reconstructs a combat beat without inferring unspoken HP or outcomes. */
export function reconstructEncounter(
  events: readonly OutlineEvent[],
  options: EncounterOptions = {},
): Encounter {
  const ordered = [...events].sort((a, b) => a.t_start_s - b.t_start_s || stable(a.id, b.id));
  const trackerEvents = ordered.filter((event) => event.turnorder !== undefined);
  const tracker = trackerEvents.length > 0;
  const rolls = occurrences(ordered, options);
  const firstInitiative = rolls.findIndex((item) => item.roll.kind === "initiative");
  // A table that never touches the tracker and calls initiative out loud still
  // played the fight. Refusing the beat would drop it from the notes entirely,
  // so the order is inferred from who acts first and anything unresolvable is
  // reported as an unassigned roll with a reason.
  const activeRolls = tracker
    ? rolls
    : (() => {
        const candidate = firstInitiative < 0 ? rolls : rolls.slice(firstInitiative);
        const collapse = candidate.findIndex(
          (item, index) => index > 0 && item.time - candidate[index - 1]!.time > 20,
        );
        return candidate.slice(0, collapse < 0 ? candidate.length : collapse);
      })();
  const turns: TurnState[] = [];
  const unassigned: { roll_id: string; reason: string }[] = [];
  const participantIds = new Set<string>();
  const damageByActor = new Map<string, number>();
  const damageByTarget = new Map<string, number>();
  let round = 1;
  const cycleActors = new Set<string>();
  let snapshotNames: string[] = [];
  const orderFromFirst = tracker ? undefined : [...new Set(rolls.map((item) => item.actorName))];

  for (const occurrence of activeRolls) {
    const trackerOrder = trackerAt(ordered, occurrence.time);
    const names =
      trackerOrder === undefined ? (orderFromFirst ?? []) : orderNames(trackerOrder.entries);
    const index = names.findIndex(
      (name) => name === occurrence.actorName || options.actorByName?.[name] === occurrence.actor,
    );
    if (names.join("\u0000") !== snapshotNames.join("\u0000")) {
      snapshotNames = names;
      // Someone who left the order cannot hold the round open. If they are
      // inserted again later they start a fresh turn rather than a second one.
      for (const actor of [...cycleActors]) if (!names.includes(actor)) cycleActors.delete(actor);
    }
    if (occurrence.actor === null)
      unassigned.push({ roll_id: occurrence.id, reason: "actor could not be resolved" });
    else if (names.length === 0)
      unassigned.push({ roll_id: occurrence.id, reason: "no initiative order was available" });
    else if (index < 0)
      unassigned.push({ roll_id: occurrence.id, reason: "actor is absent from initiative order" });
    else {
      // Cycle membership is keyed on the *initiative order's* name, not on
      // `actorName`: the tracker says "A" where the event says "ch_a", so
      // comparing across the two namespaces never matched, which is what made
      // every combat collapse into a single endless round.
      const orderName = names[index]!;
      // One action per participant per round, so a participant acting twice is
      // the wrap. Comparing order *positions* cannot do this job: an insertion,
      // a removal or a delay renumbers every index mid-fight, and a party that
      // acts out of turn looks like a wrap that never happened.
      //
      // Initiative is not a turn — it is what establishes the order — so it is
      // recorded against its actor without opening their round.
      if (occurrence.roll.kind !== "initiative") {
        if (cycleActors.has(orderName)) {
          round += 1;
          cycleActors.clear();
        }
        cycleActors.add(orderName);
      }
      const turn = addTurn(turns, occurrence, round);
      turn.rollIds.push(occurrence.id);
      turn.rollEvidence.push(evidence(occurrence));
      const target = targetFor(occurrence.roll);
      if (occurrence.roll.kind === "damage" && target !== null) {
        turn.damage += occurrence.roll.total;
        damageByActor.set(
          occurrence.actor!,
          (damageByActor.get(occurrence.actor!) ?? 0) + occurrence.roll.total,
        );
        damageByTarget.set(target, (damageByTarget.get(target) ?? 0) + occurrence.roll.total);
      }
      participantIds.add(occurrence.actor);
    }
  }

  const window = options.narration_window_s ?? 8;
  for (const event of ordered.filter(
    (item) => item.kind === "speech" && item.source_refs.utterances.length > 0,
  )) {
    const actor = event.speaker_character_id;
    if (actor === null || actor === undefined) continue;
    const nearest = turns
      .filter((turn) => turn.actor === actor && Math.abs(turn.time - event.t_start_s) <= window)
      .sort((a, b) => Math.abs(a.time - event.t_start_s) - Math.abs(b.time - event.t_start_s))[0];
    nearest?.narration.push(...event.source_refs.utterances);
  }

  const notable = activeRolls
    .filter((item) =>
      item.roll.dice.some((die) => die.sides === 20 && (die.value === 20 || die.value === 1)),
    )
    .map((item) => item.id);
  const rounds = [...new Set(turns.map((turn) => turn.round))]
    .sort((a, b) => a - b)
    .map((n) => ({
      n,
      turns: turns
        .filter((turn) => turn.round === n)
        .sort((a, b) => a.time - b.time || stable(a.actorName, b.actorName))
        .map(finalizeTurn),
    }));
  const damage = Object.fromEntries([...damageByActor.entries()].sort(([a], [b]) => stable(a, b)));
  const damageTargets = Object.fromEntries(
    [...damageByTarget.entries()].sort(([a], [b]) => stable(a, b)),
  );
  const reconstructionEvidence = tracker
    ? []
    : [
        `initiative cluster opened at ${rolls[firstInitiative]?.time.toFixed(2) ?? "unknown"}s with ${activeRolls.filter((item) => item.roll.kind === "initiative").length} initiative roll(s)`,
        `roll-density collapse closed the inferred encounter at ${activeRolls.at(-1)?.time.toFixed(2) ?? "unknown"}s`,
      ];
  return {
    rounds,
    participants: [...participantIds].sort(stable),
    reconstruction: tracker ? "tracker" : "inferred",
    reconstruction_evidence: reconstructionEvidence,
    notable_roll_ids: notable,
    unassigned_rolls: unassigned,
    damage_by_actor: damage,
    damage_by_target: damageTargets,
    summary: {
      rounds: rounds.length,
      total_damage: Object.values(damage).reduce((sum, value) => sum + value, 0),
      notable_count: notable.length,
    },
  };
}

export const buildEncounter = reconstructEncounter;
