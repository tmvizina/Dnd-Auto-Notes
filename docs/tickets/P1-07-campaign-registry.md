---
id: P1-07
phase: 1
title: Campaign registry and identity mapping
status: todo
assignee: ""
depends_on: [P0-06]
scope:
  - packages/core/src/campaign/**
  - campaign/README.md
estimate: M
commit: ""
---

## Why
Three namespaces have to meet: Discord users (audio tracks), Roll20 accounts (rolls), and characters (the thing the notes are actually about). This registry is the only place that join exists, and it is long-lived campaign state rather than per-session data.

## Do
1. Read/write `campaign/players.json`, `campaign/npcs.json`, `campaign/campaign.json`, `campaign/glossary.md`, `campaign/lexicon.ooc.json`, validated against the contracts from `P0-06`.
2. Lookups: `byDiscordUser`, `byRoll20Account`, `byCharacterId`, `charactersActiveAt(sessionNumber)` (characters join and die — attribution must respect `active_from` / `active_to`).
3. NPC registry with aliases, first-seen session, and the DM who voices them. New NPCs can be appended mid-pipeline by `P2-08` without hand-editing.
4. `suggestMappings(unmatched, registry)` — fuzzy match unmapped Craig usernames and Roll20 account names against the registry, returning ranked candidates with scores. Suggest only; never auto-apply.
5. `npm run campaign:init` scaffolds a registry from a session's intake by listing every observed Discord user and Roll20 account with blanks to fill in, so the first session is a form-filling exercise rather than a schema-reading exercise.
6. Name normalisation for matching: case folding, accent stripping, punctuation removal, and Discord discriminator stripping — used for matching only, never for display.

## Acceptance
- [ ] A registry round-trips through read and write with no field loss.
- [ ] `charactersActiveAt` excludes a character retired before the session.
- [ ] Fuzzy suggestions rank the correct player first for the fixture's near-miss names.
- [ ] `campaign:init` on the synthetic fixture emits a registry stub containing every observed identity.
- [ ] Validation rejects a duplicate character id and a player with no identities.
- [ ] Nothing in this module auto-applies a fuzzy match.

## Notes
Getting a mapping wrong is silent and poisons everything downstream — that is why suggestion and application are deliberately separate.
