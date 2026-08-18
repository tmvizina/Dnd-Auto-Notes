---
id: P4-05
phase: 4
title: Sessions list and intake UI
status: in_progress
assignee: "luna-p4-05"
depends_on: [P4-03, P1-09]
scope:
  - app/ui/src/pages/Sessions.tsx
  - app/ui/src/pages/Sessions.test.tsx
  - app/ui/src/pages/Intake.tsx
  - app/ui/src/pages/Intake.test.tsx
  - app/ui/src/App.tsx
  - app/ui/src/pages.tsx
  - app/ui/src/transport.ts
  - app/ui/src/transport.test.ts
  - app/desktop/src/main/handlers/sessions.ts
  - app/desktop/src/main/handlers/sessions.test.ts
  - app/desktop/src/shared/contracts.ts
  - app/desktop/src/shared/contracts.test.ts
  - app/desktop/src/preload/index.ts
  - app/desktop/src/preload/index.test.ts
  - app/desktop/src/main/ipc.ts
  - app/desktop/src/main/ipc.test.ts
  - app/desktop/src/main/main.ts
  - app/desktop/src/main/main.test.ts
estimate: M
commit: ""
---

## Why

This is the front door: pick a past session to read, or start a new one. The intake page is also where the user finds out that their Roll20 capture is from the wrong evening — while that is still cheap to fix.

## Do

1. Sessions list from the database index: number, title, date, duration, stage status chips, QA grade, and whether `session.md` exists. Sort and filter by date and grade.
2. New session: title, number, date; scaffolds the folder and shows exactly where to drop the Craig download and the Roll20 capture, with a copy-path button and a reveal-in-file-manager action.
3. Drag-and-drop of files onto the intake page copies them into the right subfolder, with a progress indicator for multi-gigabyte audio.
4. A one-click **Run intake** that streams progress and then renders the QA report inline: errors first, each with its hint and, where the fix is a registry edit, a direct link into the mapping editor.
5. Mapping editor: unmapped Craig tracks and Roll20 accounts with ranked suggestions from `P1-07`. The user picks; the app writes `campaign/players.json`. Suggestions are never auto-applied.
6. Re-running intake after a mapping fix is one click and always permitted.

## Acceptance

- [ ] The list reflects the folder state, including sessions created outside the app.
- [ ] Creating a session scaffolds the folder and shows the drop paths.
- [ ] Drag-and-drop of a 2 GB file shows progress and does not freeze the UI.
- [ ] QA errors render with hints and link to the mapping editor.
- [ ] Mapping edits write the registry and re-running intake clears the error.
- [ ] A missing input produces a clear message, never a stack trace.
