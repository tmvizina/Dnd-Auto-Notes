---
id: P1-05
phase: 1
title: Roll20 capture parser
status: approved
assignee: "orchestrator"
depends_on: [P1-04, P0-06]
scope:
  - packages/core/src/intake/roll20/**
  - packages/core/src/index.ts
  - tools/fixture-roll20.mjs
estimate: L
commit: ""
---

## Why

The parsed roll stream is what makes combat reconstruction possible and what anchors the Roll20 timeline to the audio. It is also the part most likely to break when Roll20 ships a UI change, so it needs to be pure, fixture-driven, and replayable against stored raw HTML.

## Do

1. Accept both input shapes: `roll20-capture.json` from `P1-04` and a saved chat-archive HTML page. Normalise both into one internal message list before parsing.
2. Parse each message into a discriminated union: `chat`, `emote`, `whisper`, `description`, `roll`, `system`, `turnorder`.
3. Roll parsing produces `{ id, seq, who, player_id, formula, dice: [{ sides, value, dropped }], modifiers, total, kind }` where `kind` is inferred from the roll template and text: `attack`, `damage`, `save`, `check`, `initiative`, `death_save`, `other`. Support inline rolls, `/roll` output, and 5e roll templates (`sheet-rolltemplate-atk`, `-dmg`, `-simple`, `-npcaction`, and the unknown-template fallback).
4. Advantage/disadvantage: capture both d20 results and which was used.
5. Turn-order events parse into `{ seq, entries: [{ name, value, token_id }] }`; derive `combat_started` / `combat_ended` markers from a transition into or out of a non-empty tracker.
6. Extract NPC name mentions from description and roll-template markup — this feeds DM-to-NPC assignment in `P2-08`.
7. Every parsed record keeps `raw_ref` pointing at its source message so the review UI can show the original.
8. Anything unrecognised becomes `kind: "other"` with the raw text preserved and a counter in the QA report. Unrecognised input is never dropped.

## Acceptance

- [x] All fixture message kinds parse into the right variant.
- [x] An attack roll with advantage yields both d20 values and the used one.
- [x] A damage roll with a dropped die records `dropped: true` on the right die.
- [x] Turn-order transitions produce combat start and end markers at the right sequence positions.
- [x] Unknown roll templates round-trip as `other` with text intact and are counted.
- [x] Parsing the HTML archive and the JSON capture of the same session yields identical normalised output apart from timing fields.
- [x] The parser is pure: no filesystem, no network, no clock.

## Notes

Roll20 message ids are the join key used by `P1-06`; never renumber or synthesise them.
