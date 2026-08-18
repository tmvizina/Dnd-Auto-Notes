import type { Player } from "../contracts/campaign.js";
import { normaliseName, similarity } from "./normalise.js";
import { byDiscordUser, byRoll20Account } from "./registry.js";
import type { Registry } from "./registry.js";

/**
 * Fuzzy identity matching. This module *suggests* and never applies: a wrong
 * binding is silent and poisons every downstream attribution, so a human or an
 * explicit call has to make the choice.
 */

export type IdentityKind = "discord" | "roll20";

export interface Candidate {
  readonly player_id: string;
  readonly display_name: string;
  readonly score: number;
  /** Which stored value produced the score, so a review UI can show it. */
  readonly matched_on: string;
}

export interface Suggestion {
  readonly observed: string;
  readonly kind: IdentityKind;
  /** Set only when an exact identity match exists — no scoring involved. */
  readonly exact: string | null;
  readonly candidates: Candidate[];
}

/** Below this, a suggestion is noise and offering it invites a wrong click. */
export const SUGGEST_MIN_SCORE = 0.4;

function candidateValues(player: Player, kind: IdentityKind): string[] {
  if (kind === "discord") {
    return [
      player.discord.username,
      ...player.discord.craig_track_hints,
      player.display_name,
    ].filter((value): value is string => value !== undefined);
  }
  return [player.roll20.account_name, player.display_name].filter(
    (value): value is string => value !== undefined,
  );
}

export function suggestFor(
  registry: Registry,
  observed: string,
  kind: IdentityKind,
  limit = 3,
): Suggestion {
  const exactPlayer =
    kind === "discord" ? byDiscordUser(registry, observed) : byRoll20Account(registry, observed);

  const candidates: Candidate[] = [];
  for (const player of registry.players) {
    let best = 0;
    let matchedOn = "";
    for (const value of candidateValues(player, kind)) {
      const score = similarity(observed, value);
      if (score > best) {
        best = score;
        matchedOn = value;
      }
    }
    if (best >= SUGGEST_MIN_SCORE) {
      candidates.push({
        player_id: player.id,
        display_name: player.display_name,
        score: Number(best.toFixed(4)),
        matched_on: matchedOn,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.player_id.localeCompare(b.player_id));

  return {
    observed,
    kind,
    exact: exactPlayer?.id ?? null,
    candidates: candidates.slice(0, limit),
  };
}

export function suggestMappings(
  registry: Registry,
  unmatched: ReadonlyArray<{ observed: string; kind: IdentityKind }>,
  limit = 3,
): Suggestion[] {
  return unmatched.map((item) => suggestFor(registry, item.observed, item.kind, limit));
}

/**
 * Builds a registry stub from the identities a session actually contains, with
 * blanks where a human must decide. Turning the first session into a
 * form-filling exercise rather than a schema-reading one.
 */
export function buildRegistryStub(observed: {
  discordUsers: readonly string[];
  roll20Accounts: readonly string[];
}): { players: Player[] } {
  const players: Player[] = [];
  const seen = new Map<string, Player>();

  const slug = (value: string) =>
    `pl_${
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "unknown"
    }`;

  for (const user of observed.discordUsers) {
    const id = slug(user);
    const player: Player = {
      id,
      display_name: user,
      is_dm: false,
      discord: { username: user, craig_track_hints: [] },
      roll20: { player_ids: [] },
      characters: [],
    };
    seen.set(id, player);
    players.push(player);
  }

  // A Roll20 account attaches to a Discord player only on an *exact* normalised
  // match, which is not a guess — "Cyd H." and "cyd_h" are the same string once
  // case and punctuation are folded. Anything less gets its own row and is
  // reported as a suggestion: a wrong identity binding is silent, and silently
  // wrong is the one failure this project cannot afford.
  for (const account of observed.roll20Accounts) {
    const wanted = normaliseName(account);
    const exact = players.find(
      (player) => normaliseName(player.discord.username ?? player.display_name) === wanted,
    );
    if (exact !== undefined) {
      exact.roll20 = { account_name: account, player_ids: [] };
      continue;
    }
    const id = slug(account);
    if (seen.has(id)) continue;
    const player: Player = {
      id,
      display_name: account,
      is_dm: false,
      discord: { craig_track_hints: [] },
      roll20: { account_name: account, player_ids: [] },
      characters: [],
    };
    seen.set(id, player);
    players.push(player);
  }

  return { players };
}
