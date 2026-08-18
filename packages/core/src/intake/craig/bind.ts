import { normaliseName } from "../../campaign/normalise.js";
import type { Registry } from "../../campaign/registry.js";
import { suggestFor } from "../../campaign/suggest.js";
import type { Candidate } from "../../campaign/suggest.js";
import type { Track } from "../../contracts/manifest.js";
import type { CraigParticipant } from "./info.js";
import type { CraigName } from "./names.js";

/**
 * Binding a track to a player is the single most consequential decision intake
 * makes. Every persona score, every line of the notes, every correction the
 * human makes later is downstream of it, and a wrong binding produces output
 * that looks exactly as confident as a right one.
 *
 * So the evidence is ranked and the weakest tier is deliberately hard to reach:
 * an unmatched track is a loud QA error that a human fixes once, in
 * `players.json`, after which the match is exact forever.
 */

export type MatchKind = Track["match"];

/** Below this a fuzzy match is a guess dressed up as a decision. */
export const FUZZY_MIN_SCORE = 0.8;

/**
 * Two candidates this close together mean the evidence does not distinguish
 * them, however high the top score is. Picking either would be a coin flip.
 */
export const FUZZY_MIN_MARGIN = 0.05;

export interface BindingInput {
  readonly trackId: string;
  readonly name: CraigName;
  /** The `info.txt` row for this track, when one could be associated with it. */
  readonly participant: CraigParticipant | null;
}

export interface Binding {
  readonly trackId: string;
  readonly playerId: string | null;
  readonly match: MatchKind;
  readonly score?: number;
  /** Populated whenever `playerId` is null, so the QA error can name names. */
  readonly candidates: Candidate[];
  /** Why the binding landed where it did, in a form a human can read. */
  readonly reason: string;
}

function byDiscordId(registry: Registry, userId: string): string | null {
  const player = registry.players.find((candidate) => candidate.discord.user_id === userId);
  return player?.id ?? null;
}

/**
 * Exact on the normalised form, against the username, the hints, and — last —
 * the display name. Normalisation folds case and punctuation only, so this is
 * still an identity match rather than a similarity one.
 */
function byUsername(registry: Registry, observed: string): string[] {
  const wanted = normaliseName(observed);
  if (wanted === "") return [];
  // Every match, not the first: two players sharing a display name is an
  // ambiguity the registry has to resolve. Taking whichever one `find` reached
  // first would be a guess that looks exactly like a decision.
  return registry.players
    .filter(
      (candidate) =>
        (candidate.discord.username !== undefined &&
          normaliseName(candidate.discord.username) === wanted) ||
        candidate.discord.craig_track_hints.some((hint) => normaliseName(hint) === wanted) ||
        normaliseName(candidate.display_name) === wanted,
    )
    .map((candidate) => candidate.id);
}

/** The names worth matching a track on, strongest first, deduplicated. */
function observedNames(input: BindingInput): string[] {
  const names = [input.participant?.username, input.name.username, input.name.stem];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (name === undefined || name.trim() === "") continue;
    const key = normaliseName(name);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Runs in strength order across *all* tracks rather than per track, because a
 * player can only own one track: a weak match must not claim a player that a
 * later, stronger match would have taken.
 */
export function bindTracks(registry: Registry, inputs: readonly BindingInput[]): Binding[] {
  const bindings = new Map<string, Binding>();
  const takenBy = new Map<string, string>();

  const claim = (
    input: BindingInput,
    playerId: string,
    match: MatchKind,
    reason: string,
    score?: number,
  ): boolean => {
    const holder = takenBy.get(playerId);
    if (holder !== undefined) {
      // Two tracks for one Discord user is not something Craig produces; it
      // means the registry or the filenames are wrong, and guessing which
      // track is "really" theirs would silently discard someone's audio.
      bindings.set(input.trackId, {
        trackId: input.trackId,
        playerId: null,
        match: "unmatched",
        candidates: candidatesFor(registry, input),
        reason: `${playerId} is already bound to track ${holder}`,
      });
      return true;
    }
    takenBy.set(playerId, input.trackId);
    bindings.set(input.trackId, {
      trackId: input.trackId,
      playerId,
      match,
      ...(score === undefined ? {} : { score }),
      candidates: [],
      reason,
    });
    return true;
  };

  const pending = (): BindingInput[] => inputs.filter((input) => !bindings.has(input.trackId));

  // Tier 1 — the Discord snowflake from info.txt. Ids do not change and do not
  // collide, so nothing later is allowed to override this.
  for (const input of pending()) {
    const userId = input.participant?.userId;
    if (userId === undefined || userId === null) continue;
    const playerId = byDiscordId(registry, userId);
    if (playerId !== null) claim(input, playerId, "discord_id", `discord user id ${userId}`);
  }

  // Tier 2 — an exact username, hint or display name.
  for (const input of pending()) {
    for (const observed of observedNames(input)) {
      const matches = byUsername(registry, observed);
      if (matches.length === 0) continue;

      if (matches.length > 1) {
        bindings.set(input.trackId, {
          trackId: input.trackId,
          playerId: null,
          match: "unmatched",
          candidates: candidatesFor(registry, input),
          reason: `${String(matches.length)} players answer to "${observed}" (${matches.join(", ")})`,
        });
        break;
      }

      claim(input, matches[0] ?? "", "username", `exact name match on "${observed}"`);
      break;
    }
  }

  // Tier 3 — fuzzy, and only when one candidate is both strong and clear of the
  // next. Anything less becomes an unmatched track with its candidate list.
  for (const input of pending()) {
    const candidates = candidatesFor(registry, input);
    const best = candidates[0];
    const runnerUp = candidates[1];

    if (best === undefined || best.score < FUZZY_MIN_SCORE) {
      bindings.set(input.trackId, {
        trackId: input.trackId,
        playerId: null,
        match: "unmatched",
        candidates,
        reason:
          best === undefined
            ? "no registry player resembles this track name"
            : `best candidate ${best.player_id} scored ${best.score.toFixed(2)}, below ${String(FUZZY_MIN_SCORE)}`,
      });
      continue;
    }

    if (runnerUp !== undefined && best.score - runnerUp.score < FUZZY_MIN_MARGIN) {
      bindings.set(input.trackId, {
        trackId: input.trackId,
        playerId: null,
        match: "unmatched",
        candidates,
        reason: `${best.player_id} and ${runnerUp.player_id} are too close to separate (${best.score.toFixed(2)} vs ${runnerUp.score.toFixed(2)})`,
      });
      continue;
    }

    claim(
      input,
      best.player_id,
      "fuzzy",
      `fuzzy match on "${best.matched_on}" scoring ${best.score.toFixed(2)}`,
      best.score,
    );
  }

  // Ordered as the caller supplied them, so the manifest follows track order.
  return inputs.map(
    (input) =>
      bindings.get(input.trackId) ?? {
        trackId: input.trackId,
        playerId: null,
        match: "unmatched" as const,
        candidates: [],
        reason: "no evidence of any kind",
      },
  );
}

/** Top candidates across every name we observed for the track, best first. */
export function candidatesFor(registry: Registry, input: BindingInput, limit = 3): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const observed of observedNames(input)) {
    const suggestion = suggestFor(registry, observed, "discord", registry.players.length);
    for (const candidate of suggestion.candidates) {
      const existing = best.get(candidate.player_id);
      if (existing === undefined || candidate.score > existing.score) {
        best.set(candidate.player_id, candidate);
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.player_id.localeCompare(b.player_id))
    .slice(0, limit);
}
