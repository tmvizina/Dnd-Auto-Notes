# Campaign

Long-lived state that outlives any one session. This is where the three
namespaces meet — Discord users (who own the audio tracks), Roll20 accounts
(who own the rolls), and characters (what the notes are actually about).

Everything downstream assumes `players.json` is correct. A wrong binding here
is silent: it does not crash, it produces confident nonsense four stages later.
That is why nothing in the tooling ever applies a fuzzy match on its own.

## Files

| File               | What it holds                                                     |
| ------------------ | ----------------------------------------------------------------- |
| `campaign.json`    | Name, system, timezone, session numbering                         |
| `players.json`     | The identity join table, and each player's characters             |
| `npcs.json`        | NPCs the DM voices, with aliases and first-seen session           |
| `glossary.md`      | In-world proper nouns — one per list item; prose is ignored       |
| `lexicon.ooc.json` | Weighted out-of-character markers for the lexical rules (`P2-06`) |
| `voice-profiles/`  | Persistent per-voice centroids (`P2-05`)                          |
| `labels/`          | Append-only human corrections that calibration fits against       |

## Starting a campaign

```bash
npm run campaign:init -- --session sessions/<id> --out campaign
```

This reads the Craig track filenames and the Roll20 capture and writes a
`players.json` stub containing every identity it saw. It binds a Roll20 account
to a Discord user **only** when the two names are identical once case and
punctuation are folded — `Cyd H.` and `cyd_h` are the same string, so that is
not a guess. Anything less similar gets its own row and is reported as a ranked
suggestion for you to merge by hand.

Then fill in the parts only you know: display names, which player is the DM, and
each player's characters.

## Characters come and go

`active_from` and `active_to` take a session marker (`s05`). Attribution will
not offer a character who had not been created yet, or one retired three
sessions ago — so a dead character stops appearing in the notes automatically.

## Nothing real, if you share this repo

The fixtures are synthetic on purpose. If you publish this repository, remember
that `campaign/` is where your table's real names live.
