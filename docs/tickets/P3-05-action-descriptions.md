---
id: P3-05
phase: 3
title: Action description extraction
status: todo
assignee: ""
depends_on: [P3-02]
scope:
  - packages/core/src/outline/actions.ts
  - packages/core/src/outline/actions.test.ts
estimate: M
commit: ""
---

## Why

A log of rolls is not a story. What makes session notes readable is the sentence a player said out loud about what their character was doing — and that sentence is already in the transcript, usually within a few seconds of the roll.

## Do

1. Extract declared actions from speech using a shallow, deterministic pattern layer over the word-timestamped transcript: first-person intent ("I ", "I'm going to ", "I want to ", "can I "), imperative movement and combat verbs, and the DM's second-person narration of results ("the arrow catches him in the shoulder").
2. Normalise each into `{ actor, verb, object, target, modifiers, span, source_utterance_id, verbatim }`, always keeping the verbatim text. The verbatim quote is the deliverable; the parse is for grouping and search.
3. Link each action to the roll it produced, using the `P2-09` anchoring and turn assignment from `P3-03`.
4. Distinguish a declaration ("I attack the captain") from a result narration ("you hit for nine") and attribute the latter to the DM.
5. Handle in-character declarations phrased in character ("Seren draws her blade and steps into the gap") as well as out-of-character mechanical ones ("I take the attack action"). Both belong in the notes; only one belongs in the dialogue section.
6. Confidence per extraction; below threshold it becomes a plain quote rather than a structured action. A quote is always safe, a wrong structured action is not.

## Acceptance

- [ ] Fixture declarations extract with the right actor and verb.
- [ ] Every action links to its roll where one exists.
- [ ] Declarations and result narrations are distinguished.
- [ ] Verbatim text is preserved for every extraction.
- [ ] Low-confidence parses degrade to quotes and never to a wrong structured action.
