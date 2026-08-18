#!/usr/bin/env node
// Generates a complete synthetic session: audio, Roll20 capture in both
// shapes, campaign registry, and the ground truth every stage test asserts
// against. Deterministic given a seed, and containing no real names, no real
// audio and no real Roll20 export.
//
//   node tools/generate-fixture.mjs --out test/fixtures/session-synthetic
//   node tools/generate-fixture.mjs --out /tmp/f --with-defects

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeWav, renderTrack } from "./fixture-audio.mjs";
import { buildMessages, toArchiveHtml, toCaptureJson } from "./fixture-roll20.mjs";
import {
  CHARACTERS,
  DEFAULT_SECONDS,
  GLOSSARY,
  NPCS,
  PLAYERS,
  ROLLS,
  SAMPLE_RATE,
  TURN_ORDER,
  UTTERANCES,
} from "./fixture-script.mjs";

const RECORDING_START = Date.UTC(2026, 7, 16, 23, 4, 11);
const SESSION_ID = "2026-08-16-fixture";
const GAME_ID = "game_fixture";

/** Distinct fundamentals so each speaker is separable, and the DM's NPC voice differs from their own. */
const VOICE_HZ = { pl_ash: 196, pl_bly: 110, pl_cyd: 262, pl_dm: 147 };
const NPC_VOICE_HZ = 88;

function parseArgs(argv) {
  const args = { out: null, seconds: DEFAULT_SECONDS, seed: 1, withDefects: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--out") args.out = argv[++i] ?? null;
    else if (flag === "--seconds") args.seconds = Number(argv[++i]);
    else if (flag === "--minutes") args.seconds = Number(argv[++i]) * 60;
    else if (flag === "--seed") args.seed = Number(argv[++i]);
    else if (flag === "--with-defects") args.withDefects = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.out === null) {
    console.log(
      [
        "Usage: node tools/generate-fixture.mjs --out <dir> [options]",
        "",
        "  --out <dir>       Where to write the session (required).",
        "  --seconds <n>     Recording length. Default 60.",
        "  --minutes <n>     Same, in minutes.",
        "  --seed <n>        PRNG seed. Same seed, byte-identical output.",
        "  --with-defects    Add the three defects P1-10's QA checks look for.",
      ].join("\n"),
    );
    return args.help ? 0 : 2;
  }

  const root = args.out;
  rmSync(root, { recursive: true, force: true });

  // --- audio -------------------------------------------------------------
  const tracks = [];
  for (const player of PLAYERS) {
    const mine = UTTERANCES.filter((u) => u.player === player.id);
    // In-character lines get a different fundamental on the same track: one
    // person, two voices, which is exactly what persona attribution has to
    // separate. The two schedules partition the utterances — they must not
    // overlap, or the voices would sum into a third thing.
    const inCharacter = mine.filter((u) => u.mode === "in_character");
    const ownVoice = mine.filter((u) => u.mode !== "in_character");
    const schedule = ownVoice.map((u) => ({ start: u.start, end: u.end }));
    const npcSchedule = inCharacter.map((u) => ({ start: u.start, end: u.end }));

    let seconds = args.seconds;
    let silent = false;
    if (args.withDefects && player.id === "pl_cyd") seconds = args.seconds - 3; // short track
    if (args.withDefects && player.id === "pl_bly") silent = true; // absent participant

    const base = renderTrack(silent ? [] : schedule, {
      seconds,
      sampleRate: SAMPLE_RATE,
      fundamental: VOICE_HZ[player.id],
      seed: args.seed + player.track,
    });

    if (!silent && npcSchedule.length > 0) {
      const npc = renderTrack(npcSchedule, {
        seconds,
        sampleRate: SAMPLE_RATE,
        fundamental: NPC_VOICE_HZ,
        seed: args.seed + 100 + player.track,
      });
      // Disjoint in time, so a straight add cannot clip or blend.
      for (let i = 0; i < base.length; i += 1) base[i] += npc[i] ?? 0;
    }

    const name = `${player.track}-${player.discord}.wav`;
    write(join(root, "input", "craig", name), encodeWav(base, SAMPLE_RATE));
    tracks.push({ player_id: player.id, file: name, duration_s: seconds, silent });
  }

  write(
    join(root, "input", "craig", "info.txt"),
    [
      `Recording ${GAME_ID}`,
      `Started: ${new Date(RECORDING_START).toISOString()}`,
      `Channels: ${String(PLAYERS.length)}`,
      ...PLAYERS.map((p) => `  ${String(p.track)}: ${p.discord}`),
      "",
    ].join("\n"),
  );

  // --- roll20 ------------------------------------------------------------
  const messages = buildMessages(RECORDING_START);
  writeJson(join(root, "input", "roll20", "roll20-capture.json"), toCaptureJson(messages, GAME_ID));
  write(join(root, "input", "roll20", "chat-archive.html"), toArchiveHtml(messages, GAME_ID));

  // --- campaign ----------------------------------------------------------
  const campaign = join(root, "campaign");
  writeJson(join(campaign, "campaign.json"), {
    name: "Thornwatch (fixture)",
    system: "D&D 5e",
    timezone: "UTC",
    session_prefix: "s",
  });
  writeJson(join(campaign, "players.json"), {
    players: PLAYERS.map((p) => ({
      id: p.id,
      display_name: p.display,
      is_dm: p.isDm,
      discord: { username: p.discord, craig_track_hints: [] },
      // The defect: one player's Roll20 account is missing, so their rolls
      // cannot be attributed to anyone.
      roll20:
        args.withDefects && p.id === "pl_cyd"
          ? { player_ids: [] }
          : { account_name: p.roll20, player_ids: [] },
      characters: CHARACTERS.filter((c) => c.playerId === p.id).map((c) => ({
        id: c.id,
        name: c.name,
        aliases: c.aliases,
      })),
    })),
  });
  writeJson(join(campaign, "npcs.json"), {
    npcs: NPCS.map((n) => ({ id: n.id, name: n.name, aliases: n.aliases, voiced_by: "pl_dm" })),
  });
  write(
    join(campaign, "glossary.md"),
    ["# Glossary", "", ...GLOSSARY.map((term) => `- ${term}`), ""].join("\n"),
  );

  // --- session + ground truth -------------------------------------------
  writeJson(join(root, "session.json"), {
    id: SESSION_ID,
    title: "Fixture Session",
    number: 42,
    date: "2026-08-16",
    created_at: new Date(RECORDING_START).toISOString(),
  });

  writeJson(join(root, "truth.json"), {
    session_id: SESSION_ID,
    seed: args.seed,
    recording: {
      started_at: new Date(RECORDING_START).toISOString(),
      duration_s: args.seconds,
      sample_rate: SAMPLE_RATE,
    },
    tracks,
    utterances: UTTERANCES.map((u) => ({
      id: u.id,
      player_id: u.player,
      start_s: u.start,
      end_s: u.end,
      mode: u.mode,
      character_id: u.character,
      text: u.text,
      announces_roll: u.roll ?? null,
    })),
    rolls: ROLLS.map((r) => ({
      id: r.id,
      player_id: r.player,
      kind: r.kind,
      total: r.total,
      announced_by: UTTERANCES.find((u) => u.roll === r.id)?.id ?? null,
    })),
    turnorder: TURN_ORDER,
    defects: args.withDefects
      ? [
          { code: "ROLL20_ACCOUNT_UNMAPPED", subject: "pl_cyd" },
          { code: "TRACK_DURATION_MISMATCH", subject: "pl_cyd" },
          { code: "TRACK_SILENT", subject: "pl_bly" },
        ]
      : [],
  });

  const utteranceCount = UTTERANCES.length;
  console.log(
    `Wrote fixture to ${root}: ${String(PLAYERS.length)} tracks, ${String(utteranceCount)} utterances, ` +
      `${String(ROLLS.length)} rolls${args.withDefects ? ", 3 defects" : ""}.`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
