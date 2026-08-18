---
id: P1-04
phase: 1
title: Roll20 browser capture script
status: todo
assignee: ""
depends_on: [P0-01]
scope:
  - tools/roll20-capture.js
  - docs/roll20-capture.md
estimate: M
commit: ""
---

## Why

Roll20 has no export worth using. Everything mechanical that happened in the session — every roll, every turn-order change — is locked in a browser tab, and the quality of the final notes depends on getting it out with usable timestamps.

## Do

1. A single dependency-free file that pastes into the Chrome console on an open Roll20 game tab. No build step, no extension, no bundler.
2. **Live mode** (`dndCapture.start()`): attach a `MutationObserver` to the chat container, stamp every new message with `Date.now()` and a monotonic `performance.now()`, and buffer to `localStorage` under a session key so a page reload does not lose the evening. Also observe the turn-order tracker and record every change as an event.
3. **Post-hoc mode** (`dndCapture.dump()`): walk the existing chat DOM and emit every message present, in order, with whatever timing can be recovered.
4. `dndCapture.save()` triggers a download of `roll20-capture.json`: `{ version, captured_at, mode, game_id, messages: [...], turnorder_events: [...] }`. Each message keeps its raw `outerHTML` alongside the parsed fields — parsing improvements must be replayable against old captures without re-recording a session.
5. Per message capture: `id` (`data-messageid`), `who` (the `.by` speaker label), `player_id` when present in the DOM, `kind` (`general` | `emote` | `whisper` | `desc` | `rollresult` | `system`), text content, and for rolls the formula, per-die results, and total, including 5e roll-template markup.
6. `dndCapture.status()` prints counts so the user can confirm it is actually recording.
7. Defensive: never throw into the page, never mutate the DOM, cap `localStorage` growth and warn near the quota, and survive Roll20 re-rendering the chat container.
8. `docs/roll20-capture.md`: a short, screenshot-free walkthrough the user can follow at the table, including "start this before the session" and the post-hoc rescue path.

## Acceptance

- [ ] Pasting the script into a real Roll20 tab captures messages live and downloads a valid JSON file.
- [ ] Post-hoc mode on the same tab recovers the visible backlog.
- [ ] Raw `outerHTML` is retained for every message.
- [ ] A page reload mid-session does not lose previously captured messages.
- [ ] The script throws no uncaught error over a full session and leaves the DOM unmodified.

## Notes

Roll20's DOM is not a stable API. The `outerHTML` retention is the hedge: when Roll20 changes markup, only the parser (`P1-05`) needs fixing and old captures still reparse.
