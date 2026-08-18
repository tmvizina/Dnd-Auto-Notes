// Emits the Roll20 capture in both shapes the parser must accept: the live
// JSON the console script produces, and a saved chat-archive page. Same events
// in both, so a parser test can assert they normalise identically.

import { ROLLS, TURN_ORDER, UTTERANCES } from "./fixture-script.mjs";

/** Firebase-style push ids are time-ordered; these are synthetic but stable. */
function messageId(index) {
  return `-Mfx${String(index).padStart(6, "0")}`;
}

function rollHtml(roll) {
  const sides = Number(roll.formula.match(/\d+d(\d+)/i)?.[1] ?? 20);
  const dice = roll.dice
    .map((d) => `<div class="die d${sides}" data-sides="${sides}">${d}</div>`)
    .join("");
  const template = roll.kind === "attack" ? "atk" : roll.kind === "damage" ? "dmg" : "simple";
  return (
    `<div class="sheet-rolltemplate-${template}">` +
    `<div class="sheet-label">${roll.kind}</div>` +
    (roll.target
      ? `<div class="sheet-target" data-target="${roll.target}">${roll.target}</div>`
      : "") +
    `<div class="inlinerollresult showtip" title="Rolling ${roll.formula}">` +
    `<div class="dicegrouping">${dice}</div>` +
    `<span class="basicdiceroll">+${roll.mod}</span>` +
    `<strong>${roll.total}</strong></div></div>`
  );
}

/**
 * The message stream, in Roll20's own order: chat, emote, whisper, rolls and
 * turn-order changes interleaved on the same clock as the audio.
 */
export function buildMessages(recordingStartMs) {
  const events = [];
  const at = (seconds) => recordingStartMs + Math.round(seconds * 1000);

  events.push({
    t: 2.5,
    kind: "general",
    who: "Wren",
    text: "Welcome back to the Thornwatch road.",
  });
  events.push({
    t: 8.0,
    kind: "emote",
    who: "Ash B.",
    text: "Seren checks the treeline before answering.",
  });

  for (const roll of ROLLS) {
    const announcement = UTTERANCES.find((u) => u.roll === roll.id);
    // Rolls land just before the player says the number out loud.
    const t = announcement === undefined ? 0 : Math.max(0, announcement.start - 0.8);
    events.push({ t, kind: "rollresult", who: roll.who, roll });
  }

  events.push({
    t: 26.5,
    kind: "whisper",
    who: "Wren",
    to: "Cyd H.",
    text: "Wisp notices the second archer.",
  });
  events.push({ t: 47.0, kind: "desc", who: "Wren", text: "Blood on the sunsteel." });

  for (const turn of TURN_ORDER) {
    events.push({
      t: turn.at,
      kind: "turnorder",
      who: "Wren",
      entries: turn.entries,
      marker: turn.marker,
    });
  }

  events.sort((a, b) => a.t - b.t);
  return events.map((event, index) => ({
    ...event,
    id: messageId(index),
    t_wall_ms: at(event.t),
    seq: index,
  }));
}

export function toCaptureJson(messages, gameId) {
  return {
    version: 1,
    captured_at: new Date(messages[0]?.t_wall_ms ?? 0).toISOString(),
    mode: "live",
    game_id: gameId,
    messages: messages
      .filter((m) => m.kind !== "turnorder")
      .map((m) => ({
        id: m.id,
        seq: m.seq,
        t_wall_ms: m.t_wall_ms,
        who: m.who,
        kind: m.kind,
        text: m.text ?? "",
        to: m.to,
        roll: m.roll
          ? {
              formula: m.roll.formula,
              dice: m.roll.dice.map((value) => ({
                sides: Number(m.roll.formula.match(/\d+d(\d+)/i)?.[1] ?? 20),
                value,
                dropped: false,
              })),
              modifiers: m.roll.mod,
              total: m.roll.total,
              kind: m.roll.kind,
              target: m.roll.target,
            }
          : undefined,
        outer_html: renderMessage(m),
      })),
    turnorder_events: messages
      .filter((m) => m.kind === "turnorder")
      .map((m) => ({
        seq: m.seq,
        id: m.id,
        t_wall_ms: m.t_wall_ms,
        who: m.who,
        marker: m.marker,
        entries: m.entries,
        outer_html: renderMessage(m),
      })),
  };
}

function renderMessage(message) {
  const by = `<span class="by">${message.who}:</span>`;
  switch (message.kind) {
    case "emote":
      return `<div class="message emote" data-messageid="${message.id}" data-seq="${message.seq}"><span class="by">${message.who}:</span>${message.text}</div>`;
    case "whisper":
      return `<div class="message whisper" data-messageid="${message.id}" data-seq="${message.seq}" data-to="${message.to}">${by} (whispered to ${message.to}) ${message.text}</div>`;
    case "desc":
      return `<div class="message desc" data-messageid="${message.id}" data-seq="${message.seq}"><span class="by">${message.who}:</span>${message.text}</div>`;
    case "rollresult":
      return `<div class="message rollresult" data-messageid="${message.id}" data-seq="${message.seq}">${by}${rollHtml(message.roll)}</div>`;
    case "turnorder":
      return `<div class="message turnorder system" data-messageid="${message.id}" data-seq="${message.seq}" data-marker="${message.marker}" data-turnorder='${JSON.stringify(message.entries)}'>${by}Turn order updated</div>`;
    default:
      return `<div class="message general" data-messageid="${message.id}" data-seq="${message.seq}">${by} ${message.text}</div>`;
  }
}

/** The post-hoc shape: a saved page with no wall-clock stamps of its own. */
export function toArchiveHtml(messages, gameId) {
  const body = messages.map(renderMessage).join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>Chat Log — ${gameId}</title>`,
    "</head>",
    "<body>",
    '<div id="textchat">',
    body,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
