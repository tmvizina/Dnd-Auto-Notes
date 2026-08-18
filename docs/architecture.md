# Architecture

## The shape of the problem

Craig gives us a solved diarization problem and an unsolved _persona_ problem. Each participant already has their own audio file, so "who made this sound" is free. What we actually need is:

| Question                            | Signal that answers it                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Who spoke?                          | Craig track filename → Discord user → campaign registry                                  |
| What did they say?                  | ASR per track, word-level timestamps                                                     |
| When?                               | Craig tracks share a common t=0; Roll20 events are anchored onto that timeline           |
| Player or character?                | Voice-mode clustering + lexical rules + roll proximity                                   |
| _Which_ character? (the DM is many) | Persistent per-campaign voice-profile bank + name-introduction windows + Roll20 mentions |
| What mechanically happened?         | Roll20 rolls, roll templates, turn order                                                 |
| What narratively happened?          | Beat segmentation over the merged timeline                                               |

Everything above except the last two rows is per-utterance classification with real acoustic and lexical evidence. That is why the pipeline is deterministic: we are not asking a model to invent the answer, we are computing a score and only escalating the genuinely ambiguous minority.

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ app/desktop (Electron main)          app/ui (React + Vite renderer)  │
│  · secure BrowserWindow, custom       · sessions, intake, review,    │
│    scheme, CSP, contextIsolation        notes editor, PDF export     │
│  · IPC (invoke/handle + push events)  · transport abstraction:       │
│  · sidecar supervision                  electron bridge | http       │
│  · ProviderRunner (claude / codex)                                   │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │                                  │
┌───────────────▼──────────────────┐  ┌────────────▼───────────────────┐
│ packages/core  (@dnd/core)       │  │ packages/cli  (`pipeline`)     │
│  · session contracts + schemas   │  │  · headless stage runner       │
│  · stage runner (hash/idempotent)│  │  · same core, no Electron      │
│  · SQLite (better-sqlite3, WAL)  │  └────────────────────────────────┘
│  · Roll20 parser, campaign reg.  │
│  · persona scorer, beat splitter │
│  · notes renderer                │
│  · LLM providers (cli | http)    │
└───────────────┬──────────────────┘
                │ HTTP  127.0.0.1:8477
┌───────────────▼──────────────────────────────────────────────────────┐
│ sidecar/  (Python, FastAPI, uv-managed venv)                         │
│  · /health capability probe   · /jobs/{id} + cancel                  │
│  · VAD, ASR (mlx-whisper | faster-whisper | whisper.cpp)             │
│  · utterance embeddings (ECAPA / WavLM) + prosody features           │
│  · optional audio-native adjudication of flagged clips               │
└──────────────────────────────────────────────────────────────────────┘
```

### Why a Python HTTP sidecar rather than per-stage subprocesses

Model load dominates cost. Whisper large-v3 and an ECAPA extractor take tens of seconds to warm; a session has many stages and many re-runs during review. A long-lived process holds them in memory, so a re-run of the persona stage is seconds, not minutes. The cost is a lifecycle to supervise — which is a solved, small problem (health endpoint, port file, supervised restart) and is exactly how Audio Forge's worker already operates in production.

The sidecar **never opens the SQLite database.** It reads audio paths, writes JSON to disk, and returns results; the Node side owns all persistence. This is the rule that keeps Audio Forge's worker safe to restart at any moment, and it is adopted verbatim.

### Job protocol (ported from Audio Forge)

- Fast, pure-logic calls are synchronous.
- Anything touching a model returns `{job_id}` immediately; the caller polls `GET /jobs/{id}` for `{status, progress, message, result, error}`.
- `POST /jobs/{id}/cancel` kills the active subprocess and flags the worker thread to stop at its next checkpoint.
- A readers/writer gate serializes model-heavy work while allowing lightweight scoring to run concurrently.

Reference implementation to port: `Audio-Forge-/worker/audioforge_worker/jobs.py` and the endpoint contract at the top of `server.py`.

## Data flow

```
input/craig/*.flac ─┐
input/roll20/*.json ┤
campaign/*.json ────┘
        │
        ▼  intake            work/01-intake/manifest.json
        │                    tracks, durations, hashes, player mapping, QA report
        ▼  transcript        work/02-transcript/utterances.json
        │                    VAD segments + ASR words per track, merged timeline
        ▼  features          work/03-features/features.json
        │                    per-utterance embedding + prosody, voice-mode clusters
        ▼  persona           work/04-persona/attribution.json
        │                    speaker → {player | character}, confidence, flags
        ▼  align             work/05-align/timeline.json
        │                    Roll20 events anchored to audio time
        ▼  outline           work/06-outline/events.json
        │                    beats, encounters, rounds, checks, quotes
        ▼  notes             session.md  +  work/07-notes/qa.json
```

Every stage writes `_stage.json` alongside its output recording `{stage, version, inputs: {path: sha256}, started_at, finished_at, sidecar_versions}`. A stage is skipped when its recorded input hashes and version match; `--force` always re-runs. Re-running is never blocked.

## Persona attribution model

Per utterance `u` spoken by player `p`, compute features:

| Feature     | Source                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `lex_ooc`   | density of table/meta lexicon: dice, AC, initiative, "my turn", "does that hit", real first names      |
| `lex_ic`    | density of campaign glossary terms, in-world proper nouns, vocatives matching known PC/NPC names       |
| `roll_prox` | a roll by `p` within ±T seconds (rolls are overwhelmingly announced out of character)                  |
| `chat_prox` | a Roll20 chat message by `p` at the same moment                                                        |
| `voice_sim` | cosine similarity of `u`'s embedding to `p`'s _table-voice_ centroid vs. their best character centroid |
| `prosody_z` | z-scored F0 / rate / intensity deviation from `p`'s table-voice baseline                               |
| `addressee` | whether the utterance addresses the DM (by real name) or a character (by character name)               |

These fuse into `score_ic`. Above `hi` → in character; below `lo` → out of character; between → **flagged** with the specific reason. Character assignment for in-character utterances is nearest voice-profile centroid subject to a margin; the DM additionally gets name-introduction windows ("the innkeeper looks up and says…" opens an NPC window) and Roll20 log NPC mentions.

Thresholds are calibrated against a hand-labeled slice per campaign, not hard-coded globally. Corrections made in the review UI write back into `campaign/voice-profiles/` so the next session starts better than the last. This feedback loop is the whole reason the system improves without training a model.

**Flagged spans only** are batched to an LLM adjudicator, with the surrounding transcript window, the candidate labels, and a strict JSON response contract. Optionally the _audio_ of the clip goes to an audio-native model instead. Both sit behind one `Adjudicator` interface with a no-op fallback so the pipeline completes with zero network access.

## LLM providers

One interface, four implementations, chosen by settings:

| Provider     | Transport                                                                                         | Use                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `cli-claude` | `claude -p --output-format stream-json --verbose --permission-mode <mode>`, prompt over **stdin** | in-app agentic edits, long-form passes                              |
| `cli-codex`  | `codex exec --json`, prompt over stdin                                                            | same, when Codex is the installed CLI                               |
| `http-local` | OpenAI-compatible endpoint (LM Studio / Ollama / llama.cpp on the Mac, optionally over LAN)       | flagged-span adjudication, prose summaries                          |
| `none`       | —                                                                                                 | fully offline; flags stay flagged and are surfaced in the QA report |

Prompt goes over stdin rather than argv (Windows `.cmd` quoting and argv length limits), CLIs are resolved by an explicit platform-ordered probe, and cancel means killing the child. Reference: `Manuscript-Work/bridge/claude-bridge.js` and `Manuscript-Work/packages/core/src/execution/normalize.ts`, which already normalizes both CLIs' JSONL streams into one event union — port it rather than rewriting it.

## Desktop app rules carried over from prior projects

- `contextIsolation: true, sandbox: true, nodeIntegration: false`; one `contextBridge` object; the preload never leaks `ipcRenderer`.
- One frozen `shared/contracts.ts` is the sole source of channel names, DTOs and limits, imported by main, preload and renderer.
- Validate at every hop (preload before invoke, main on receipt including sender/frame checks, response before it crosses back) and sanitize outbound events of raw/internal fields.
- Streaming subscriptions are replay-safe: register live delivery _before_ snapshotting the buffer, number events monotonically, let the renderer de-dupe by sequence.
- The CLI runner is injected behind an interface with a deterministic fake for tests, and the fake is excluded from the packaged bundle.
- **Audio elements get no `src` until the user presses play.** An audio-heavy review list that eagerly loads decoded audio will swap-death the machine. This is not hypothetical; it happened in Audio Forge and cost a day.

## Platform

macOS / Apple Silicon is the primary target: ASR runs on Metal via `mlx-whisper`, embeddings via torch MPS, and local chat models via an OpenAI-compatible server on the same box. Windows must remain _functional_ — no hard-coded POSIX paths, `path.join` everywhere, CLI resolution probes `.cmd`/`.exe` — but is not the performance target. CI runs macOS as the primary matrix leg and Windows as a smoke leg.
