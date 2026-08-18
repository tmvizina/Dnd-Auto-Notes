import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { Campaign, Lexicon, NpcsFile, PlayersFile } from "../contracts/campaign.js";
import type { Character, Npc, Player } from "../contracts/campaign.js";
import { writeFileAtomic, writeJsonAtomic } from "../session/io.js";
import type { FileIo } from "../session/io.js";
import { normaliseName } from "./normalise.js";

export const CAMPAIGN_FILES = Object.freeze({
  campaign: "campaign.json",
  players: "players.json",
  npcs: "npcs.json",
  glossary: "glossary.md",
  lexicon: "lexicon.ooc.json",
} as const);

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface Registry {
  readonly root: string;
  readonly campaign: Campaign;
  readonly players: Player[];
  readonly npcs: Npc[];
  readonly glossary: string[];
  readonly lexicon: Lexicon | null;
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T | null): Promise<T> {
  if (!existsSync(path)) {
    if (fallback === null) throw new RegistryError("missing required file", path);
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new RegistryError(`not valid JSON: ${(error as Error).message}`, path);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new RegistryError(issues(result.error), path);
  return result.data;
}

/** Glossary terms are one per markdown list item; headings and prose are ignored. */
export function parseGlossary(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((term): term is string => term !== undefined && term.length > 0);
}

/**
 * Structural problems that make attribution impossible. Each one is silent if
 * allowed through — it poisons every downstream stage — so loading refuses.
 */
export function validateRegistry(registry: Registry): string[] {
  const problems: string[] = [];
  const playerIds = new Set<string>();
  const characterIds = new Set<string>();

  for (const player of registry.players) {
    if (playerIds.has(player.id)) problems.push(`duplicate player id ${player.id}`);
    playerIds.add(player.id);

    const hasIdentity =
      player.discord.user_id !== undefined ||
      player.discord.username !== undefined ||
      player.roll20.account_name !== undefined ||
      player.roll20.player_ids.length > 0;
    if (!hasIdentity) {
      problems.push(`player ${player.id} has no Discord or Roll20 identity to match on`);
    }

    for (const character of player.characters) {
      if (characterIds.has(character.id)) problems.push(`duplicate character id ${character.id}`);
      characterIds.add(character.id);
    }
  }

  const npcIds = new Set<string>();
  for (const npc of registry.npcs) {
    if (npcIds.has(npc.id)) problems.push(`duplicate NPC id ${npc.id}`);
    if (characterIds.has(npc.id)) problems.push(`${npc.id} is both a character and an NPC`);
    npcIds.add(npc.id);
  }

  return problems;
}

export async function loadRegistry(root: string): Promise<Registry> {
  const campaign = await readJson(join(root, CAMPAIGN_FILES.campaign), Campaign, {
    name: "Untitled campaign",
    system: "D&D 5e",
    timezone: "UTC",
    session_prefix: "s",
  });
  const players = await readJson(join(root, CAMPAIGN_FILES.players), PlayersFile, { players: [] });
  const npcs = await readJson(join(root, CAMPAIGN_FILES.npcs), NpcsFile, { npcs: [] });

  const glossaryPath = join(root, CAMPAIGN_FILES.glossary);
  const glossary = existsSync(glossaryPath)
    ? parseGlossary(await readFile(glossaryPath, "utf8"))
    : [];

  const lexiconPath = join(root, CAMPAIGN_FILES.lexicon);
  const lexicon = existsSync(lexiconPath) ? await readJson(lexiconPath, Lexicon, null) : null;

  const registry: Registry = {
    root,
    campaign,
    players: players.players,
    npcs: npcs.npcs,
    glossary,
    lexicon,
  };
  const problems = validateRegistry(registry);
  if (problems.length > 0) {
    throw new RegistryError(problems.join("; "), join(root, CAMPAIGN_FILES.players));
  }
  return registry;
}

// --- lookups ---------------------------------------------------------------

export function byDiscordUser(registry: Registry, user: string): Player | undefined {
  const wanted = normaliseName(user);
  return registry.players.find(
    (player) =>
      player.discord.user_id === user ||
      (player.discord.username !== undefined &&
        normaliseName(player.discord.username) === wanted) ||
      player.discord.craig_track_hints.some((hint) => normaliseName(hint) === wanted),
  );
}

export function byRoll20Account(registry: Registry, account: string): Player | undefined {
  const wanted = normaliseName(account);
  return registry.players.find(
    (player) =>
      player.roll20.player_ids.includes(account) ||
      (player.roll20.account_name !== undefined &&
        normaliseName(player.roll20.account_name) === wanted),
  );
}

export function byCharacterId(
  registry: Registry,
  id: string,
): { player: Player; character: Character } | undefined {
  for (const player of registry.players) {
    const character = player.characters.find((c) => c.id === id);
    if (character !== undefined) return { player, character };
  }
  return undefined;
}

export function npcById(registry: Registry, id: string): Npc | undefined {
  return registry.npcs.find((npc) => npc.id === id);
}

export function dungeonMaster(registry: Registry): Player | undefined {
  return registry.players.find((player) => player.is_dm);
}

/** Session markers look like "s07"; compare on the trailing number. */
function sessionOrdinal(marker: string | undefined): number | null {
  if (marker === undefined) return null;
  const digits = /(\d+)\s*$/.exec(marker)?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

/**
 * Characters join and die. Attribution must not offer a character who had not
 * been created yet, or one retired three sessions ago.
 */
export function charactersActiveAt(registry: Registry, sessionNumber: number): Character[] {
  const active: Character[] = [];
  for (const player of registry.players) {
    for (const character of player.characters) {
      const from = sessionOrdinal(character.active_from);
      const to = sessionOrdinal(character.active_to);
      if (from !== null && sessionNumber < from) continue;
      if (to !== null && sessionNumber > to) continue;
      active.push(character);
    }
  }
  return active;
}

export function allCharacters(registry: Registry): Character[] {
  return registry.players.flatMap((player) => player.characters);
}

// --- writing ---------------------------------------------------------------

export async function saveRegistry(registry: Registry, io?: FileIo): Promise<void> {
  await writeJsonAtomic(join(registry.root, CAMPAIGN_FILES.campaign), registry.campaign, io);
  await writeJsonAtomic(
    join(registry.root, CAMPAIGN_FILES.players),
    { players: registry.players },
    io,
  );
  await writeJsonAtomic(join(registry.root, CAMPAIGN_FILES.npcs), { npcs: registry.npcs }, io);
  await writeFileAtomic(
    join(registry.root, CAMPAIGN_FILES.glossary),
    ["# Glossary", "", ...registry.glossary.map((term) => `- ${term}`), ""].join("\n"),
    io,
  );
}

/**
 * Appends an NPC discovered mid-pipeline. Returns the registry unchanged when
 * the id is already present — DM-to-NPC assignment proposes, never overwrites.
 */
export function withNpc(registry: Registry, npc: Npc): Registry {
  if (registry.npcs.some((existing) => existing.id === npc.id)) return registry;
  return { ...registry, npcs: [...registry.npcs, npc] };
}
