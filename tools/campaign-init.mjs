#!/usr/bin/env node
// Scaffolds a campaign registry from the identities a session actually
// contains, so the first session is a form-filling exercise rather than a
// schema-reading one. It fills in what it can see and leaves blanks where a
// human has to decide — it never guesses a binding.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildRegistryStub, suggestMappings } from "@dnd/core";

const AUDIO = /\.(flac|aac|m4a|mp3|ogg|wav)$/i;
/** Craig writes `<index>-<username>[_<discriminator>].<ext>`. */
const CRAIG = /^(\d+)-(.+?)(?:_(\d{2,6}))?$/;

function parseArgs(argv) {
  const args = { session: null, out: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session") args.session = argv[++i] ?? null;
    else if (argv[i] === "--out") args.out = argv[++i] ?? null;
    else if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function discordUsersFrom(sessionDir) {
  const craig = join(sessionDir, "input", "craig");
  if (!existsSync(craig)) return [];
  return readdirSync(craig)
    .filter((name) => AUDIO.test(name))
    .sort()
    .map((name) => {
      const stem = name.replace(AUDIO, "");
      const match = CRAIG.exec(stem);
      return match?.[2] ?? stem;
    });
}

function roll20AccountsFrom(sessionDir) {
  const capture = join(sessionDir, "input", "roll20", "roll20-capture.json");
  if (!existsSync(capture)) return [];
  const parsed = JSON.parse(readFileSync(capture, "utf8"));
  const who = new Set();
  for (const message of parsed.messages ?? []) if (message.who) who.add(message.who);
  for (const event of parsed.turnorder_events ?? []) if (event.who) who.add(event.who);
  return [...who].sort();
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.session === null) {
    console.log(
      [
        "Usage: node tools/campaign-init.mjs --session <dir> [--out <campaign dir>] [--force]",
        "",
        "Reads the Craig track filenames and the Roll20 capture in a session and",
        "writes a campaign/players.json stub containing every identity it saw.",
        "Bindings it is not sure about are left blank on purpose.",
      ].join("\n"),
    );
    return args.help ? 0 : 2;
  }

  const out = args.out ?? join(args.session, "..", "..", "campaign");
  const target = join(out, "players.json");
  if (existsSync(target) && !args.force) {
    console.error(`${target} already exists. Re-run with --force to overwrite it.`);
    return 1;
  }

  const discordUsers = discordUsersFrom(args.session);
  const roll20Accounts = roll20AccountsFrom(args.session);
  if (discordUsers.length === 0 && roll20Accounts.length === 0) {
    console.error(`No identities found under ${args.session}/input. Nothing to scaffold.`);
    return 1;
  }

  const stub = buildRegistryStub({ discordUsers, roll20Accounts });
  mkdirSync(out, { recursive: true });
  writeFileSync(target, `${JSON.stringify(stub, null, 2)}\n`);

  console.log(`Wrote ${target}`);
  console.log(
    `  ${String(discordUsers.length)} Discord user(s), ${String(roll20Accounts.length)} Roll20 account(s) -> ${String(stub.players.length)} player row(s)`,
  );

  // Rows that may be one person seen through two namespaces. Reported, never
  // merged: a wrong identity binding is silent and poisons every downstream
  // attribution, so the human makes the call.
  const discordOnly = stub.players.filter(
    (p) => p.discord.username !== undefined && p.roll20.account_name === undefined,
  );
  const roll20Only = stub.players.filter(
    (p) => p.discord.username === undefined && p.roll20.account_name !== undefined,
  );

  if (discordOnly.length > 0 && roll20Only.length > 0) {
    const registry = {
      root: out,
      campaign: { name: "", system: "D&D 5e", timezone: "UTC", session_prefix: "s" },
      players: discordOnly,
      npcs: [],
      glossary: [],
      lexicon: null,
    };
    const suggestions = suggestMappings(
      registry,
      roll20Only.map((p) => ({ observed: p.roll20.account_name, kind: "discord" })),
    );
    const useful = suggestions.filter((item) => item.candidates.length > 0);
    if (useful.length > 0) {
      console.log("");
      console.log("These rows may be the same person (suggestions only, nothing merged):");
      for (const suggestion of useful) {
        const ranked = suggestion.candidates
          .map((c) => `${c.player_id} (${c.score.toFixed(2)})`)
          .join(", ");
        console.log(`  Roll20 "${suggestion.observed}" -> ${ranked}`);
      }
      console.log("  Merge by hand: keep one row and give it both identities.");
    }
  }

  console.log("\nNext: fill in display names, is_dm, and each player's characters.");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
