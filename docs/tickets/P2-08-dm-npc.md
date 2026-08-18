---
id: P2-08
phase: 2
title: DM to NPC assignment
status: done
assignee: "luna-p2-08"
depends_on: [P2-07]
scope:
  - packages/core/src/persona/dmNpc.ts
  - packages/core/src/persona/dmNpc.test.ts
estimate: L
commit: "284f415"
---

## Why

The DM is the hardest speaker in the room: one track, one voice box, and an unbounded, mid-session-growing cast. Players have one or two characters; the DM has forty, half of whom are invented on the spot and never named twice.

## Do

1. Run only over the DM's in-character utterances. Everything the DM says out of character or as narration is already handled by `P2-07`.
2. Separate **narration** from **NPC speech** for the DM: narration is third-person, past or present descriptive, and often frames a quote; NPC speech is first- or second-person. Add `mode: "narration"` for the DM specifically. Getting this split right matters more than naming the NPC.
3. Evidence for which NPC:
   - **name-introduction windows** — a narration or Roll20 description naming an NPC opens a window of `NPC_WINDOW_S` (default 45, decaying) during which that NPC is the strong prior;
   - **voice bank** — a labelled NPC voice profile from the campaign bank;
   - **Roll20 mentions** — NPC-name roll templates and `npcaction` rolls near in time;
   - **scene continuity** — the NPC of the immediately preceding DM in-character run, decayed by elapsed time and by intervening player speech;
   - **direct address** — a player addressing an NPC by name immediately before or after.
4. Combine into a ranked candidate list with a margin test. Below margin: `character_id: null`, flag `unknown_npc`, and record the top candidates so review is a one-click choice rather than a typing exercise.
5. **New NPC discovery**: a recurring unlabelled DM voice cluster with a consistent nearby name proposes a new NPC registry entry — as a _proposal_ in the QA report, never an automatic write to `campaign/npcs.json`.
6. Never assign an NPC to a player's utterance, and never assign a PC to the DM.

## Acceptance

- [x] DM narration and DM NPC speech separate correctly on the fixture.
- [x] A named NPC within the window is assigned; the same voice outside the window falls back to the voice bank.
- [x] Two NPCs voiced with the same acoustic cluster are disambiguated by name windows.
- [x] An unrecognised NPC voice flags `unknown_npc` with ranked candidates, never a guess.
- [x] New-NPC proposals appear in the QA report and write nothing.
- [x] No cross-assignment between the DM and players in either direction.
