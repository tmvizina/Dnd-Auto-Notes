import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VoiceCluster } from "./voiceModes.js";

export interface VoiceProfile {
  profile_id: string;
  centroid: number[];
  spread_radius: number;
  example_utterance_count: number;
  sessions: string[];
  version: number;
}
export interface ProfileUpdate {
  journal_id: string;
  profile_id: string;
  session_id: string;
  confirmed_utterance_ids: string[];
  previous: VoiceProfile;
  next: VoiceProfile;
  action: "update";
}
export interface BankIo {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
const pathFor = (root: string, player: string, id: string) => join(root, player, `${id}.json`);
const nativeIo: BankIo = { mkdir, writeFile, rename };
async function atomic(path: string, value: unknown, io: BankIo = nativeIo): Promise<void> {
  await io.mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)}.tmp`;
  await io.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await io.rename(temp, path);
}
function validProfile(value: unknown): value is VoiceProfile {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<VoiceProfile>;
  return (
    typeof item.profile_id === "string" &&
    item.profile_id.length > 0 &&
    Array.isArray(item.centroid) &&
    item.centroid.length > 0 &&
    item.centroid.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    typeof item.spread_radius === "number" &&
    Number.isFinite(item.spread_radius) &&
    item.spread_radius >= 0 &&
    Number.isInteger(item.example_utterance_count) &&
    (item.example_utterance_count ?? -1) >= 0 &&
    Array.isArray(item.sessions) &&
    item.sessions.every((session) => typeof session === "string" && session.length > 0) &&
    Number.isInteger(item.version) &&
    (item.version ?? 0) >= 1
  );
}

interface JournalRecord {
  state: "intent" | "committed";
  action: "update" | "revert";
  journal_id: string;
  profile_id: string;
  session_id: string;
  confirmed_utterance_ids: string[];
  previous: VoiceProfile;
  next: VoiceProfile;
}

function validJournal(value: unknown): value is JournalRecord {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<JournalRecord>;
  return (
    (item.state === "intent" || item.state === "committed") &&
    (item.action === "update" || item.action === "revert") &&
    typeof item.journal_id === "string" &&
    item.journal_id.length > 0 &&
    typeof item.profile_id === "string" &&
    typeof item.session_id === "string" &&
    Array.isArray(item.confirmed_utterance_ids) &&
    item.confirmed_utterance_ids.every((id) => typeof id === "string" && id.length > 0) &&
    validProfile(item.previous) &&
    validProfile(item.next) &&
    item.previous.profile_id === item.profile_id &&
    item.next.profile_id === item.profile_id
  );
}

async function readJournal(path: string): Promise<JournalRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return validJournal(value) ? value : null;
  } catch {
    return null;
  }
}
export async function recoverProfileBank(root: string, player: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(join(root, player, "journal")))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".committed.json"))
      .sort();
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, player, "journal", name);
    const value = await readJournal(path);
    if (value?.state !== "intent") continue;
    const journalId = value.journal_id;
    const committed = await readJournal(
      join(root, player, "journal", `${journalId}.committed.json`),
    );
    if (committed?.state === "committed" && committed.journal_id === journalId) {
      continue;
    }
    // Every intent records the desired post-operation state in `next`.
    // Replaying `previous` for a revert would restore the update being undone.
    const target = value.next;
    await writeProfile(root, player, target);
    await atomic(join(root, player, "journal", `${journalId}.committed.json`), {
      ...value,
      state: "committed",
    });
  }
}
export async function readProfiles(root: string, player: string): Promise<VoiceProfile[]> {
  await recoverProfileBank(root, player);
  let names: string[];
  try {
    names = (await readdir(join(root, player)))
      .filter((name) => name.endsWith(".json") && name !== "table.json")
      .sort();
  } catch {
    return [];
  }
  const result: VoiceProfile[] = [];
  for (const name of names) {
    try {
      const value: unknown = JSON.parse(await readFile(join(root, player, name), "utf8"));
      if (validProfile(value)) result.push(value);
    } catch {
      /* corrupt/partial files do not poison a run */
    }
  }
  return result;
}
export async function writeProfile(
  root: string,
  player: string,
  profile: VoiceProfile,
  io?: BankIo,
): Promise<void> {
  await atomic(pathFor(root, player, profile.profile_id), profile, io);
}
export async function writeTableProfile(
  root: string,
  player: string,
  profile: VoiceProfile,
  io?: BankIo,
): Promise<void> {
  await atomic(join(root, player, "table.json"), profile, io);
}
export async function readTableProfile(root: string, player: string): Promise<VoiceProfile | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, player, "table.json"), "utf8"));
    return validProfile(value) ? value : null;
  } catch {
    return null;
  }
}

export async function seedProfileBank(
  root: string,
  labels: readonly {
    utterance_id: string;
    player_id: string;
    character_id: string | null;
    embedding: readonly number[];
    session_id: string;
  }[],
): Promise<void> {
  const groups = new Map<string, (typeof labels)[number][]>();
  for (const label of labels) {
    const key = `${label.player_id}|${label.character_id ?? "table"}`;
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  for (const [key, items] of groups) {
    const [player, character] = key.split("|");
    const centroid = items[0]!.embedding.map(
      (_, index) => items.reduce((sum, item) => sum + item.embedding[index]!, 0) / items.length,
    );
    await writeProfile(root, player!, {
      profile_id: character!,
      centroid,
      spread_radius: 0,
      example_utterance_count: items.length,
      sessions: [...new Set(items.map((item) => item.session_id))].sort(),
      version: 1,
    });
  }
}

/** Seed only absent character profiles; existing human-confirmed profiles are immutable here. */
export async function seedMissingProfiles(
  root: string,
  labels: readonly {
    player_id: string;
    character_id: string | null;
    embedding: readonly number[];
    session_id: string;
  }[],
): Promise<number> {
  const groups = new Map<string, (typeof labels)[number][]>();
  for (const label of labels) {
    if (label.character_id === null) continue;
    const key = `${label.player_id}|${label.character_id}`;
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  let created = 0;
  for (const [key, items] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const [player, character] = key.split("|");
    if (player === undefined || character === undefined) continue;
    const existing = (await readProfiles(root, player)).some(
      (profile) => profile.profile_id === character,
    );
    if (existing) continue;
    const centroid = items[0]!.embedding.map(
      (_, index) => items.reduce((sum, item) => sum + item.embedding[index]!, 0) / items.length,
    );
    await writeProfile(root, player, {
      profile_id: character,
      centroid,
      spread_radius: 0,
      example_utterance_count: items.length,
      sessions: [...new Set(items.map((item) => item.session_id))].sort(),
      version: 1,
    });
    created += 1;
  }
  return created;
}
export async function updateProfile(
  root: string,
  player: string,
  profile: VoiceProfile,
  cluster: VoiceCluster,
  sessionId: string,
  decay = 0.9,
  confirmedUtteranceIds: readonly string[] = cluster.utterance_ids,
  io?: BankIo,
): Promise<ProfileUpdate> {
  const confirmed = new Set(confirmedUtteranceIds);
  if (cluster.utterance_ids.some((id) => !confirmed.has(id)))
    throw new Error("profile update requires explicitly confirmed utterance ids");
  const previous = { ...profile, centroid: [...profile.centroid], sessions: [...profile.sessions] };
  const next = {
    ...profile,
    centroid: profile.centroid.map(
      (value, i) => value * decay + (cluster.centroid[i] ?? value) * (1 - decay),
    ),
    example_utterance_count: profile.example_utterance_count + confirmed.size,
    sessions: [...new Set([...profile.sessions, sessionId])],
    version: profile.version + 1,
  };
  const update: ProfileUpdate = {
    journal_id: `${profile.profile_id}-${next.version}`,
    profile_id: profile.profile_id,
    session_id: sessionId,
    confirmed_utterance_ids: [...confirmed].sort(),
    previous,
    next,
    action: "update",
  };
  await atomic(
    join(root, player, "journal", `${update.journal_id}.json`),
    { ...update, state: "intent" },
    io,
  );
  await writeProfile(root, player, next, io);
  await atomic(
    join(root, player, "journal", `${update.journal_id}.committed.json`),
    { ...update, state: "committed" },
    io,
  );
  return update;
}
export async function revertProfile(
  root: string,
  player: string,
  update: ProfileUpdate,
  io?: BankIo,
): Promise<void> {
  const audit = {
    journal_id: `${update.journal_id}.revert`,
    profile_id: update.profile_id,
    session_id: update.session_id,
    source_version: update.next.version,
    confirmed_utterance_ids: update.confirmed_utterance_ids,
    action: "revert" as const,
    previous: update.next,
    next: update.previous,
  };
  await atomic(
    join(root, player, "journal", `${audit.journal_id}.json`),
    { ...audit, state: "intent" },
    io,
  );
  await writeProfile(root, player, update.previous, io);
  await atomic(
    join(root, player, "journal", `${audit.journal_id}.committed.json`),
    { ...audit, state: "committed" },
    io,
  );
}
