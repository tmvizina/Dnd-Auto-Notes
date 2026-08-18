---
id: P5-05
phase: 5
title: Release qualification
status: todo
assignee: ""
depends_on: [P5-04]
scope:
  - docs/release-checklist.md
estimate: S
commit: ""
---

## Why

One list, run before every release, so a version is never shipped that quietly lost a capability.

## Do

1. `docs/release-checklist.md` covering:
   - full test suite green on both CI legs;
   - a packaged build installs and launches on a clean machine;
   - the whole pipeline runs on the synthetic fixture through the packaged app;
   - the whole pipeline runs offline with the provider set to `none`;
   - review page memory stays flat over 100 clips;
   - PDF export produces a correct document;
   - performance budgets met and recorded;
   - `npm run tickets -- --check` clean, and `docs/HANDOFF.md` current;
   - no secret, no real campaign data and no real audio in the repo or the bundle.
2. Record each run of the checklist with the version, date and results.
3. Tag the release and write release notes from the ticket commits.

## Acceptance

- [ ] The checklist exists and has been executed once in full.
- [ ] Results are recorded with real numbers, not assertions.
- [ ] Any failed item has a filed ticket before release.
