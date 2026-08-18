---
id: P3-04
phase: 3
title: Skill checks and social scenes
status: todo
assignee: ""
depends_on: [P3-02]
scope:
  - packages/core/src/outline/checks.ts
  - packages/core/src/outline/checks.test.ts
estimate: M
commit: ""
---

## Why

Outside combat, checks are the beats that matter: the failed persuasion that started a fight, the insight that caught a lie. Each is a roll with a stated intent that lives in the speech around it.

## Do

1. Detect check rolls from the roll template and the skill name, and pair each with the intent stated nearby — usually the utterance immediately preceding it, occasionally a DM prompt just before that.
2. Extract a check record: actor, skill, total, the stated intent, the DM's spoken adjudication if present in the following window, and a success or failure verdict **only when it was actually stated**. A DC is rarely spoken; do not invent one.
3. Social scene structure: participants (characters, not players), the NPCs involved, the topic from repeated glossary terms, and the outcome as marked by an agreement, a refusal, or a transition to another beat.
4. Detect explicit stakes and promises — "we'll return by the new moon", "I'll pay you fifty gold" — as candidate open threads for `P3-06`.
5. Group repeated checks on the same subject into one attempt sequence rather than listing five separate persuasion rolls.

## Acceptance

- [ ] Each fixture check pairs with its stated intent.
- [ ] Verdicts appear only when the adjudication was spoken; otherwise `unknown`.
- [ ] Repeated attempts group into one sequence.
- [ ] Promises and stated stakes surface as candidate threads.
- [ ] No DC is ever fabricated.
