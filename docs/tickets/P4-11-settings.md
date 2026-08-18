---
id: P4-11
phase: 4
title: Settings
status: in_progress
assignee: "luna-p4-11"
depends_on: [P4-03]
scope:
  - app/ui/src/pages/Settings.tsx
  - app/desktop/src/main/handlers/settings.ts
estimate: S
commit: ""
---

## Why

The one machine-specific thing this app has is where its models and CLIs live. That belongs in a settings page, not in environment variables the user has to remember.

## Do

1. Paths: sessions root, campaign root, sidecar location — with validation and a reveal action.
2. Providers: default LLM provider, model per provider, permission mode for CLI runs, and an OpenAI-compatible base URL with a **Test connection** button that reports latency and the model list. This is where the LAN-served Mac endpoint is configured.
3. ASR: backend, model size, language, and glossary biasing on or off, each gated on the sidecar's reported capabilities with an explanation when unavailable.
4. Thresholds: the persona decision bands and match margins, with a warning that changing them invalidates existing attributions and a link to re-run.
5. Credentials are never stored — env or keychain references only, and the UI says so.
6. Settings are key-allow-listed at the IPC boundary and validated on write.

## Acceptance

- [ ] Every setting persists and takes effect without a restart, or says clearly that a restart is needed.
- [ ] Test connection succeeds against a local OpenAI-compatible server and fails informatively when unreachable.
- [ ] Capability-gated options are disabled with a reason.
- [ ] Threshold changes warn about invalidation.
- [ ] No credential value is ever written to the database or the settings file.
