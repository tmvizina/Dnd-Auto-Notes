# Roll20 capture at the table

The capture script is dependency-free: open the Roll20 game in Chrome, open DevTools with `Ctrl+Shift+J` (or `Cmd+Option+J`), paste the contents of [`tools/roll20-capture.js`](../tools/roll20-capture.js), and press Enter.

## Before the session

Start this before the session, while the game tab is open and the chat and turn-order panels are visible:

```js
dndCapture.start();
dndCapture.status();
```

The status result should show `recording: true`. Leave the tab open while the session runs. New chat messages and turn-order changes are timestamped with both the wall clock and a monotonic clock. The capture is also buffered in `localStorage`, so a page reload does not discard messages already seen. The script does not change Roll20's DOM.

At the end, download the capture:

```js
dndCapture.save();
```

The browser downloads `roll20-capture.json`. It contains the capture version, capture time, mode, game id, messages, and turn-order events. Each message includes its parsed fields and its original `outerHTML`.

If you start another session in the same game, save the previous one first, then clear the old buffer before calling `start()`:

```js
dndCapture.clear();
dndCapture.start();
```

## Post-hoc rescue

If the script was not started at the beginning, paste it into the still-open game tab and run:

```js
dndCapture.dump();
dndCapture.save();
```

`dump()` walks the visible chat backlog in DOM order. It recovers any timing attributes Roll20 exposes; messages without recoverable timing keep `null` timing fields. Only the visible backlog can be rescued after the fact, and a page that has already been closed cannot be reconstructed by this script.

If the tab reloaded mid-session, paste the script again, run `dndCapture.start()`, and then `dndCapture.save()`. The prior buffer is restored from the same game session key before live observation resumes.

If storage is near its safety cap, the console warns you. Save the JSON promptly; the oldest records are capped only to protect the browser from a quota failure.
