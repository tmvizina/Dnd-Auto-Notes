# Fixtures

**Generated, not committed.** `tools/generate-fixture.mjs` writes a complete
synthetic session — four WAV tracks, a Roll20 capture in both shapes, a campaign
registry, and `truth.json` — deterministically from a seed.

```bash
npm run fixture:generate                                   # -> session-synthetic/
node tools/generate-fixture.mjs --out /tmp/f --with-defects
```

Nothing here is real: the players, characters, NPCs and place names are
invented, and the audio is synthesised tones and noise. No campaign recording,
no Roll20 export, and no participant's name may ever be committed to this repo.

## Why it is not checked in

- `.gitignore` excludes `*.wav` deliberately — audio does not belong in git.
- The output is ~4 MB per generation; committing regenerated binaries would
  bloat history for no gain.
- Byte-identical output for a given seed makes generating equivalent to
  storing. Tests call the generator directly into a temp directory.

## What `truth.json` carries

Ground truth for every stage to assert against: utterance boundaries, which
player spoke, whether they were in character and as whom, and which roll each
announcement corresponds to. Also the three defects `--with-defects` injects,
which is what `P1-10`'s QA checks are measured against.
