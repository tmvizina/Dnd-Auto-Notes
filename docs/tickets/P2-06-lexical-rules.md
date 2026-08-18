---
id: P2-06
phase: 2
title: Lexical rule engine
status: done
assignee: "luna-p2-06"
depends_on: [P2-03, P1-07]
scope:
  - packages/core/src/persona/lexical.ts
  - packages/core/src/persona/lexical.test.ts
  - campaign/lexicon.ooc.json
estimate: M
commit: "b25f2c9"
---

## Why

Acoustics tell you a voice changed; words tell you what it changed into. "Does a nineteen hit?" is out of character no matter how it is delivered, and a rules engine catches that with certainty an embedding never will.

## Do

1. A weighted marker engine over utterance text producing `lex_ooc` and `lex_ic` densities plus the specific markers that fired, so every decision is explainable.
2. Out-of-character marker classes, shipped as a default lexicon and extensible per campaign:
   - dice and mechanics — `d20`, `natural twenty`, `advantage`, `initiative`, `AC`, `hit points`, `saving throw`, `crit`, `modifier`;
   - table procedure — `my turn`, `whose turn`, `can I`, `does that hit`, `roll for`, `I'll go`, `end my turn`;
   - meta reference — real player first names from the registry, `the DM`, `the module`, `last session`, `rules as written`;
   - the room — `pizza`, `back in a sec`, `sorry, mic`.
3. In-character marker classes: campaign glossary terms and in-world proper nouns, character names used as vocatives, second-person address to another character, and archaic or register-marked diction (`aye`, `thee`, `milord`) as a weak signal only.
4. **Quoted speech inside narration**: the DM saying `the guard says "halt"` is narration containing character speech. Detect quote spans with word timestamps so the quoted portion can be attributed separately from its frame. This is a common case, not an edge case.
5. Number handling: an utterance whose only content is a number matching a roll total within the alignment window is a strong out-of-character marker — resolved together with `P2-09`.
6. Normalisation: lowercase, strip punctuation, expand contractions, and map spoken numbers to digits for matching.
7. Everything pure and table-driven; no model, no network, no clock.

## Acceptance

- [x] Each marker class fires on its fixture cases and not on the counterexamples.
- [x] Quoted speech inside a narration utterance is located with word-time spans.
- [x] Spoken numbers match digit forms.
- [x] A player's real first name spoken by another player scores out-of-character; a character name does not.
- [x] Every score comes with the list of markers that produced it.
- [x] Adding a campaign glossary term changes `lex_ic` with no code change.
