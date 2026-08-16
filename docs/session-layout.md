# Session & campaign data contract

This is the on-disk contract every stage reads and writes. It is deliberately plain JSON on a plain filesystem: any stage can be re-run, inspected, diffed, or replaced without touching the database.

## Layout

```
campaign/
  campaign.json              name, system, timezone, session numbering
  players.json               the identity join table (see below)
  npcs.json                  known NPCs, aliases, owning DM
  glossary.md                in-world proper nouns, places, factions, items
  lexicon.ooc.json           table/meta terms that mark out-of-character speech
  voice-profiles/
    <player-id>/
      table.json             centroid + prosody baseline for their own voice
      <character-id>.json    centroid + prosody baseline per character they play
  labels/
    <session-id>.jsonl       human corrections, append-only, feeds calibration

sessions/
  2026-08-16-s42/
    session.json             id, title, number, date, status, stage states
    input/
      craig/                 the Craig download: tracks + info.txt (zip or extracted)
      roll20/                roll20-capture.json (or .html)
      notes.txt              optional human scratch notes, verbatim into the appendix
    work/
      01-intake/manifest.json        + _stage.json
      02-transcript/utterances.json  + _stage.json
      03-features/features.json      + _stage.json
      04-persona/attribution.json    + _stage.json
      05-align/timeline.json         + _stage.json
      06-outline/events.json         + _stage.json
      07-notes/qa.json               + _stage.json
    media/
      clips/<utterance-id>.wav       lazily extracted review clips (gitignored)
    session.md               the deliverable
    session.pdf              exported on demand
```

`sessions/*/input/`, `sessions/*/media/` and any audio are gitignored. Stage JSON is small and *is* committed for a real session if the user wants history; that is a per-user choice, not a requirement.

## Identity join — `campaign/players.json`

The single place where the three namespaces meet. Everything downstream assumes this file is correct.

```json
{
  "players": [
    {
      "id": "pl_maddie",
      "display_name": "Maddie",
      "discord": { "user_id": "204...", "username": "maddiecodes", "craig_track_hints": ["maddie"] },
      "roll20": { "account_name": "Maddie R.", "player_ids": ["-N9x..."] },
      "is_dm": false,
      "characters": [
        { "id": "ch_seren", "name": "Seren Thaldane", "aliases": ["Seren"], "active_from": "s01" }
      ]
    },
    {
      "id": "pl_tom",
      "display_name": "Tom",
      "discord": { "username": "tmviz" },
      "roll20": { "account_name": "Tom" },
      "is_dm": true,
      "characters": []
    }
  ]
}
```

The DM's characters live in `npcs.json` instead, because they are open-ended and get added mid-session.

Intake fuzzy-matches Craig track filenames and Roll20 account names against this file and **fails loudly with a suggestion list** rather than guessing. An unmapped participant is a hard QA error, not a warning: every downstream attribution depends on it.

## `work/01-intake/manifest.json`

```json
{
  "session_id": "2026-08-16-s42",
  "recording": { "started_at": "2026-08-16T23:04:11Z", "duration_s": 14682.3, "source": "craig" },
  "tracks": [
    { "track_id": "t1", "path": "input/craig/1-maddiecodes.flac", "player_id": "pl_maddie",
      "sha256": "…", "duration_s": 14682.3, "sample_rate": 48000, "channels": 2,
      "speech_ratio": 0.18, "aligned": true }
  ],
  "roll20": { "path": "input/roll20/roll20-capture.json", "sha256": "…",
              "message_count": 1841, "roll_count": 612, "capture_mode": "live",
              "time_basis": "wallclock" },
  "qa": { "errors": [], "warnings": ["track t4 speech_ratio 0.002 — was this player present?"] }
}
```

`time_basis` is one of `wallclock` (live capture stamped each message), `messageid` (recovered from Roll20 message ids), or `order_only` (ordering is known, absolute time is not). Downstream alignment behaves differently for each and says so in the QA report.

## `work/02-transcript/utterances.json`

The merged, ordered timeline. One record per utterance, an utterance being a VAD-bounded run of speech on one track.

```json
{
  "utterances": [
    { "id": "u000412", "track_id": "t1", "player_id": "pl_maddie",
      "start_s": 3241.88, "end_s": 3247.02,
      "text": "I don't like this. We should leave before it wakes.",
      "words": [{ "t": "I", "s": 3241.88, "e": 3241.99 }],
      "asr": { "backend": "mlx-whisper", "model": "large-v3", "avg_logprob": -0.21 },
      "overlap_ids": ["u000413"] }
  ]
}
```

## `work/04-persona/attribution.json`

```json
{
  "attributions": [
    { "utterance_id": "u000412", "mode": "in_character", "character_id": "ch_seren",
      "confidence": 0.91,
      "evidence": { "voice_sim": 0.83, "lex_ic": 0.4, "lex_ooc": 0.0, "roll_prox": false,
                    "prosody_z": 1.7 },
      "flags": [] },
    { "utterance_id": "u000413", "mode": "uncertain", "character_id": null,
      "confidence": 0.44,
      "flags": [{ "code": "persona_ambiguous", "reason": "voice_sim below margin (0.61 vs 0.58)" }] }
  ],
  "summary": { "in_character": 1204, "out_of_character": 2891, "uncertain": 173,
               "unknown_npc": 41 }
}
```

`mode` ∈ `in_character | out_of_character | uncertain | non_speech`. Flags carry a machine-readable `code` so the review UI can group them and the adjudicator can prompt specifically.

## `work/06-outline/events.json`

```json
{
  "beats": [
    { "id": "b07", "kind": "combat", "start_s": 4102.0, "end_s": 5233.5,
      "title": "Ambush at the ford",
      "participants": ["ch_seren", "npc_bandit_captain"],
      "encounter": {
        "rounds": [
          { "n": 1, "turns": [
            { "actor": "ch_seren", "rolls": ["r0412"],
              "narration_utterances": ["u000512", "u000514"],
              "summary_source": "deterministic" } ] } ] },
      "utterance_ids": ["u000512"], "roll_ids": ["r0412"] }
  ]
}
```

Every beat, round and turn references the utterance and roll ids it was built from. The notes renderer may only state things that are reachable from those references — that constraint is what keeps the output honest and is enforced by a test.

## Stage sidecar file — `_stage.json`

```json
{ "stage": "transcript", "version": 3, "status": "ok",
  "inputs": { "work/01-intake/manifest.json": "sha256:…" },
  "params_hash": "sha256:…",
  "started_at": "…", "finished_at": "…", "duration_s": 812.4,
  "sidecar": { "version": "0.3.1", "asr_backend": "mlx-whisper", "model": "large-v3" },
  "counts": { "utterances": 4268 } }
```

A stage re-runs when any input hash, the stage version, or the params hash differs — or when `--force` is passed. `--force` is always available; no stage may refuse to run because it "already ran".
