---
id: P3-06
phase: 3
title: Notes renderer
status: todo
assignee: ""
depends_on: [P3-03, P3-04, P3-05]
scope:
  - packages/core/src/render/**
  - packages/core/src/render/templates/**
estimate: L
commit: ""
---

## Why

This is the deliverable. Everything before it exists to make this file accurate, and the rendering must not add a single claim the pipeline cannot support.

## Do

1. Render `session.md` deterministically from `events.json`. Sections:
   - front matter: session number, date, duration, players present, characters present;
   - **Summary** — 5 to 10 sentences assembled from beat titles and outcomes;
   - **Dramatis personae** — characters and NPCs appearing, with first-appearance timestamps;
   - **Timeline** — one subsection per beat, with a timestamp range, a title, what happened, notable in-character dialogue, and the rolls that mattered;
   - **Combat** — per encounter, a round-by-round table and a summary;
   - **Rolls of note** — natural 20s and 1s, criticals, failed death saves, the highest and lowest of the night;
   - **Open threads** — promises, stated stakes and unresolved hooks from `P3-04`;
   - **Table notes** — out-of-character items worth keeping (scheduling, rules decisions);
   - **Uncertainties** — spans the pipeline could not attribute, with timestamps, so a reader knows exactly where the record is thin;
   - appendix: verbatim human notes from `input/notes.txt` if present.
2. Dialogue is rendered as `**Seren Thaldane:** "…"` with the timestamp; out-of-character speech never appears in the dialogue sections, only in table notes.
3. Every rendered statement carries provenance in a machine-checkable form — a timestamp anchor and, in a hidden HTML comment, the source event ids. A test parses the rendered file and asserts every claim resolves.
4. Confidence rendering: attributions below a threshold are marked (for instance `*Seren Thaldane (uncertain)*`). The reader must be able to tell what the machine was sure about.
5. Templates are data files, not string concatenation in code, so wording changes need no code change.
6. Stable output: re-rendering unchanged input produces a byte-identical file, so `git diff` on notes shows real changes only.

## Acceptance

- [ ] Rendering the fixture produces every section with correct content.
- [ ] The grounding test proves every statement resolves to referenced event ids.
- [ ] Out-of-character speech never appears in dialogue sections.
- [ ] Uncertain attributions are visibly marked.
- [ ] Re-rendering unchanged input is byte-identical.
- [ ] The **Uncertainties** section lists every open flag with its timestamp.
