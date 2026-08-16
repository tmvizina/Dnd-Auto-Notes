---
id: P0-01
phase: 0
title: Repo scaffold, workspaces, TypeScript
status: todo
assignee: ""
depends_on: []
scope:
  - package.json
  - tsconfig.base.json
  - .gitignore
  - packages/core/**
  - packages/cli/**
estimate: M
commit: ""
---

## Why
Nothing else can be built or tested until the workspace layout, module system and TypeScript settings are fixed. Getting this wrong later means touching every package.

## Do
1. Root `package.json`: private, `"type": "module"`, npm workspaces `["packages/core", "packages/cli", "app/desktop", "app/ui"]`. Only create `packages/*` now; the `app/*` entries land in phase 4 and an absent workspace is tolerated.
2. Scripts: `typecheck`, `test`, `build`, `lint`, `format`, `pipeline` (delegates to `packages/cli`), `session:new`.
3. `tsconfig.base.json`: ES2022, NodeNext module + resolution, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`. Each workspace extends it and adds its own `tsconfig.build.json` with `outDir`/`rootDir`.
4. `packages/core` (`@dnd/core`) and `packages/cli` (`@dnd/cli`), each `src/index.ts` building to `dist/`, with an `exports` map.
5. `.gitignore`: `node_modules`, `dist`, `.venv`, `sessions/*/input/`, `sessions/*/media/`, `*.wav`, `*.flac`, `*.mp3`, `*.db*`, `sessions/*/session.pdf`.
6. Pin Node 22 in `engines` plus `.nvmrc`.
7. `packages/cli` exposes a `pipeline` bin stub that prints its resolved config and exits 0.

## Acceptance
- [ ] `npm install` succeeds on a clean checkout on macOS and Windows.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm run build` emits `packages/*/dist`.
- [ ] `npx pipeline --help` prints usage.
- [ ] No workspace imports another by relative path, only by package name.

## Verify
```bash
npm install && npm run typecheck && npm run build && npx pipeline --help
```

## Notes
Mirror the workspace + ESM setup in `Manuscript-Work/package.json`, including its Windows-explicit `npm.cmd` in fan-out scripts.
