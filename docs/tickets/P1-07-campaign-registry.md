---
id: P1-07
phase: 1
title: Campaign registry and identity mapping
status: approved
assignee: "orchestrator"
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

- [x] A registry round-trips through read and write with no field loss.
- [x] `charactersActiveAt` excludes a character retired before the session.
- [x] Fuzzy suggestions rank the correct player first for the fixture's near-miss names.
- [x] `campaign:init` on the synthetic fixture emits a registry stub containing every observed identity.
- [x] Validation rejects a duplicate character id and a player with no identities.
- [x] Nothing in this module auto-applies a fuzzy match.

## Notes

Getting a mapping wrong is silent and poisons everything downstream — that is why suggestion and application are deliberately separate.

## Delivered

`packages/core/src/campaign/` — `normalise.ts` (matching-only name folding and a dependency-free similarity score), `registry.ts` (load, validate, save, lookups) and `suggest.ts` (ranked candidates, registry stub). 35 tests. `npm run campaign:init` wires it to a real session.

Three bugs found by running it against the fixture rather than reading it:

- **A flat prefix bonus outranked closer matches.** `similarity("Ashh B.", "Ash")` scored 0.85 on the prefix rule while the genuinely closer `"Ash B."` scored 0.83, so the wrong value was reported as the match. The bonus now scales with how much of the longer string the prefix covers.
- **Whole-string comparison could not see a shared stem.** `"Ash B."` vs `"ashcodes"` scored 0.375 — below the noise floor — because the tokens differ and the strings diverge after three characters. That is exactly the shape of a Discord handle derived from a name, so token-level prefix matching was added; it now scores 0.75 and is offered as a suggestion.
- **An identical token made `similarity()` return 1.** `similarity("Wren", "wren_dm")` hit 1.0 through the token-prefix rule, and `buildRegistryStub` was using `=== 1` as its exactness test — so it bound the DM's Roll20 account to a Discord user on partial evidence. Partial evidence is now capped below 1, and exactness is tested with normalised string equality directly. **This was the ticket's own "nothing auto-applies a fuzzy match" rule being violated by the implementation**, and it is the failure mode this project can least afford: silent, and wrong four stages later.

The stub therefore binds a Roll20 account to a Discord user **only** when the two names are identical once case, accents, punctuation and Discord discriminators are folded — `Cyd H.` and `cyd_h` are the same string, which is not a guess. On the synthetic fixture that yields one automatic binding and three ranked suggestions the human merges by hand.

Verified: registries round-trip with no field loss; `charactersActiveAt` respects `active_from`, `active_to` and both together; duplicate character ids, an id used as both character and NPC, and a player with no matchable identity are all rejected at load; `withNpc` appends but never overwrites; and `campaign:init` on the synthetic fixture emits a row for every observed identity with nothing auto-bound beyond exact matches.
