---
id: P4-08
phase: 4
title: Flagged-span review page
status: in_progress
assignee: "luna-p4-08"
depends_on: [P4-06, P2-08]
scope:
  - app/ui/src/pages/Review.tsx
  - app/ui/src/pages/Review.test.tsx
  - app/ui/src/components/ClipPlayer.tsx
  - app/ui/src/components/ClipPlayer.test.tsx
  - app/ui/src/App.tsx
  - app/ui/src/pages.tsx
  - app/ui/src/transport.ts
  - app/ui/src/transport.test.ts
  - app/ui/src/styles.css
  - app/desktop/src/main/handlers/review.ts
  - app/desktop/src/main/handlers/review.test.ts
  - app/desktop/src/shared/contracts.ts
  - app/desktop/src/shared/contracts.test.ts
  - app/desktop/src/preload/index.ts
  - app/desktop/src/preload/index.test.ts
  - app/desktop/src/main/ipc.ts
  - app/desktop/src/main/ipc.test.ts
  - app/desktop/src/main/main.ts
  - app/desktop/src/main/main.test.ts
estimate: L
commit: ""
---

## Why

This page is where the system learns. Every correction here both fixes this session's notes and improves the campaign voice bank, which is the only mechanism by which accuracy compounds across sessions.

## Do

1. List open flags grouped by code, sorted by impact (how much speech time the decision affects). Each row: timestamp, speaker, transcript text, candidate labels with scores, and the evidence that made it uncertain.
2. **Lazy audio.** `ClipPlayer` sets no `src` until the user presses play, releases the object URL on pause or unmount, and allows at most one playing clip at a time. Non-negotiable: an eager list of decoded clips will exhaust memory and lock the machine.
3. Clip extraction on demand into `media/clips/`, cached, with a retention cap.
4. Resolution actions: pick a candidate, enter a new character or NPC, mark out-of-character, mark unresolvable. Each writes the attribution, closes the flag, and appends to `campaign/labels/<session>.jsonl`.
5. Confirmed labels update the voice profile bank through `updateProfile`, journalled and revertible. Show what a correction taught the system.
6. Keyboard-first: play, next, previous, and number keys for candidates. Reviewing 150 flags must take minutes, not an hour.
7. Bulk actions: apply one label to every flag in an unlabelled cluster, since a cluster is usually one voice.
8. **After a voice-profile change, offer to re-run persona attribution for the affected utterances.** A stale attribution left beside an updated profile is how a fix silently reverts.

## Acceptance

- [ ] No `<audio>` element has a `src` before play is pressed, proven by a DOM test.
- [ ] Memory is flat after playing 100 clips sequentially.
- [ ] Resolving a flag updates the attribution, the flag row and the label file.
- [ ] A profile update is journalled and revertible from the UI.
- [ ] Bulk cluster labelling applies to every member.
- [ ] Full keyboard operation with no mouse.
- [ ] Re-running attribution after corrections is offered and works.
