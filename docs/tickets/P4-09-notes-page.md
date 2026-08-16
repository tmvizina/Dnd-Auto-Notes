---
id: P4-09
phase: 4
title: Notes viewer and editor
status: todo
assignee: ""
depends_on: [P4-06, P4-07]
scope:
  - app/ui/src/pages/Notes.tsx
  - app/desktop/src/main/handlers/notes.ts
estimate: L
commit: ""
---

## Why
The generated notes are a strong draft, not a final document. The user needs to fix a name, cut a tangent, or ask for a section to be rewritten — without leaving the app and without losing the connection back to the timestamps.

## Do
1. Render `session.md` with the source markdown one keystroke away. Timestamp anchors are clickable and play the corresponding audio through the same lazy `ClipPlayer`.
2. Direct editing with autosave to `session.md`, debounced, atomic writes, and an on-disk change watcher that warns rather than clobbering if the file changed underneath.
3. Local undo history per session, plus a snapshot before any LLM edit so a bad rewrite is one click away from reverted.
4. LLM edit requests scoped to a selection or a section: the user types an instruction, the app builds a prompt containing only the selected text and the relevant events, streams the result through `P4-07`, and shows a diff to accept or reject. Never apply a model edit without showing the diff.
5. Regenerate actions: re-render notes from events (discarding manual edits, with confirmation), or re-render one beat only, preserving edits elsewhere.
6. Show the QA grade and the uncertainties list beside the document, with each uncertainty linking to the review page.

## Acceptance
- [ ] Edits persist to `session.md` and survive an app restart.
- [ ] Timestamp anchors play the right audio.
- [ ] An LLM edit shows a diff and applies only on accept.
- [ ] Undo reverts an LLM edit completely.
- [ ] An external change to the file warns instead of overwriting.
- [ ] Regenerating one beat leaves edits in other beats intact.
