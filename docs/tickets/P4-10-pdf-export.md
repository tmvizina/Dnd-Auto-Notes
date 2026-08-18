---
id: P4-10
phase: 4
title: PDF export
status: todo
assignee: ""
depends_on: [P4-09]
scope:
  - app/desktop/src/main/export/**
  - app/ui/src/components/ExportDialog.tsx
estimate: M
commit: ""
---

## Why

The notes get shared with the table, and a PDF is what people actually read. It needs to look like a document, not like a rendered README.

## Do

1. Render the markdown to styled HTML in an offscreen `BrowserWindow` and export with `webContents.printToPDF`.
2. Print stylesheet: a real title page with session number, date and party; running headers; page numbers; sensible page breaks that never orphan a beat heading from its body; monospace only where it belongs.
3. Options: include or omit table notes, out-of-character content, the uncertainties section, and the roll appendix. Defaults suit sharing with players — narrative in, machinery out.
4. Save via a native dialog, defaulting to `sessions/<id>/session.pdf`.
5. All assets inlined; the export must work offline and embed no remote fonts.
6. Export is cancellable and reports progress for long documents.

## Acceptance

- [ ] A 40-page session exports with correct pagination and headers.
- [ ] Each option changes the output as described.
- [ ] No beat heading is orphaned at a page break.
- [ ] Export works with no network access.
- [ ] Cancelling closes the offscreen window and leaves no partial file.
