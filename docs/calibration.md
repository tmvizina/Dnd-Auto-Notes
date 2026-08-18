# Voice feature calibration

The P2-05 bake-off uses the committed deterministic P2-04-derived fixtures at
`packages/core/src/persona/fixtures/session-{501,502}.json`, generated with
`tools/generate-fixture.mjs --seed 501/502` and the sidecar `DND_FAKE_EMBED`
path. Each fixture records the generator arguments, truth SHA-256, backend,
and dimension. For each labelled utterance we compute cosine agglomerative
clusters and sweep thresholds `[0.18, 0.22, 0.28, 0.34]` and concatenated
prosody weights `[0.2, 0.35, 0.5]`; the test harness asserts vector provenance
and the selected threshold/weight.

| representation                     |   purity |
| ---------------------------------- | -------: |
| embedding only                     | 1.000000 |
| prosody only                       | 1.000000 |
| concatenated (prosody weight 0.20) | 1.000000 |

The deterministic tie rule selects the first representation in the order shown,
then the lowest threshold and weight: embedding-only, threshold `0.18`,
prosody weight `0.20`. The embedding-only representation is selected because it avoids
prosody scale and missing-field sensitivity; prosody remains available for
table-voice weighting and later calibration. The test is the executable source
of measured purity/accuracy values, rather than hand-entered claims.

Using the same threshold (`0.18`) and the session-501 majority-labelled bank,
session 502 reaches measured cluster-label accuracy `1.000000` (4/4 labelled
clusters); the acceptance floor recorded by the test is `0.800000`.

## Label calibration runs

`pipeline calibrate --campaign <dir>` appends one dated row after every
successful fit. Reports contain held-out k-fold precision/recall/F1, threshold
trade-offs, and profile-bank accuracy before and after seeding. The active
pointer changes without replacing an older scorer version.

| date | campaign/session | labels | accuracy | profile before | profile after |
| ---- | ---------------- | -----: | -------: | -------------: | ------------: |
