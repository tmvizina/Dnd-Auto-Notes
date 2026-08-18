import { describe, expect, it } from "vitest";
import { normalizeRoll20Input, parseRoll20 } from "./parser.js";
import {
  buildMessages,
  toArchiveHtml,
  toCaptureJson,
  // @ts-expect-error The fixture helper is intentionally a plain checked-in .mjs script.
} from "../../../../../tools/fixture-roll20.mjs";

const attackHtml =
  '<div class="message rollresult" data-messageid="-Mattack"><span class="by">Ash:</span>' +
  '<div class="sheet-rolltemplate-atk"><div class="sheet-label">Attack</div>' +
  '<div class="inlinerollresult" title="Rolling 2d20kh1+7 = 25">' +
  '<div class="die d20">12</div><div class="die d20">18</div><strong>25</strong>' +
  "</div></div></div>";

describe("Roll20 capture parser", () => {
  it("keeps generated capture JSON and archive HTML semantically equivalent", () => {
    const messages = buildMessages(1_700_000_000_000);
    const json = parseRoll20(toCaptureJson(messages, "fixture"));
    const html = parseRoll20(toArchiveHtml(messages, "fixture"));
    const shape = (value: typeof json) =>
      value.messages.map((message) => ({
        kind: message.kind,
        id: message.id,
        seq: message.seq,
        who: message.who,
        text: message.text,
        to: "to" in message ? message.to : null,
        marker: "marker" in message ? message.marker : null,
        entries: "entries" in message ? message.entries : null,
      }));
    expect(shape(json)).toEqual(shape(html));
  });
  it("parses every ordinary capture message variant and keeps raw references", () => {
    const result = parseRoll20({
      messages: [
        { id: "m-chat", who: "Ash", kind: "general", text: "Hello" },
        { id: "m-emote", who: "Ash", kind: "emote", text: "waves" },
        { id: "m-whisper", who: "Wren", kind: "whisper", to: "Cyd", text: "Secret" },
        { id: "m-desc", who: "Wren", kind: "desc", text: "The Goblin King waits." },
        { id: "m-system", kind: "system", text: "Round 1" },
      ],
    });

    expect(result.messages.map((message) => message.kind)).toEqual([
      "chat",
      "emote",
      "whisper",
      "description",
      "system",
    ]);
    expect(result.messages.every((message) => message.raw_ref === message.id)).toBe(true);
    expect(result.messages.find((message) => message.kind === "whisper")).toMatchObject({
      to: "Cyd",
    });
    expect(
      result.messages.find((message) => message.kind === "description")?.npc_mentions,
    ).toContain("Goblin King");
  });

  it("keeps both d20s and identifies the used advantage result", () => {
    const result = parseRoll20(attackHtml);
    const roll = result.rolls[0];
    expect(roll).toBeDefined();
    expect(roll?.dice).toEqual([
      { sides: 20, value: 12, dropped: true },
      { sides: 20, value: 18, dropped: false },
    ]);
    expect(roll).toMatchObject({
      kind: "attack",
      advantage: "advantage",
      used: 18,
      total: 25,
    });
  });

  it("does not treat roll-template labels as NPC mentions", () => {
    const result = parseRoll20(
      '<div class="message rollresult" data-messageid="-Mlabels"><span class="by">Ash:</span>' +
        '<div class="sheet-rolltemplate-atk"><div class="sheet-label">Longsword Attack</div>' +
        '<div>Damage 1d8+3</div><div class="inlinerollresult" title="Rolling 1d20+5 = 17">17</div>' +
        "</div></div>",
    );
    expect(result.rolls[0]?.npc_mentions).toEqual([]);
  });

  it("retains a dropped damage die from capture JSON", () => {
    const result = parseRoll20({
      messages: [
        {
          id: "-Mdamage",
          seq: 4,
          who: "Ash",
          player_id: "pl_ash",
          kind: "rollresult",
          text: "Damage",
          roll: {
            formula: "2d6+3",
            dice: [
              { sides: 6, value: 2, dropped: false },
              { sides: 6, value: 5, dropped: true },
            ],
            modifiers: 3,
            total: 5,
            kind: "damage",
          },
          outer_html: '<div class="message rollresult" data-messageid="-Mdamage"></div>',
        },
      ],
    });
    expect(result.rolls[0]).toMatchObject({
      id: "-Mdamage",
      seq: 4,
      player_id: "pl_ash",
      kind: "damage",
    });
    expect(result.rolls[0]?.dice[1]).toEqual({ sides: 6, value: 5, dropped: true });
  });

  it("derives combat markers from turn-order transitions", () => {
    const result = parseRoll20({
      messages: [{ id: "m-chat", kind: "general", text: "Roll initiative" }],
      turnorder_events: [
        {
          id: "m-start",
          seq: 7,
          entries: [{ name: "Goblin", value: 14, token_id: "tok-g" }],
        },
        {
          id: "m-change",
          seq: 8,
          entries: [
            { name: "Goblin", value: 14, token_id: "tok-g" },
            { name: "Ash", value: 12 },
          ],
        },
        { id: "m-end", seq: 9, entries: [] },
      ],
    });
    expect(result.turnorder.map((event) => event.marker)).toEqual([
      "combat_started",
      "changed",
      "combat_ended",
    ]);
    expect(result.combat_markers.map((marker) => marker.kind)).toEqual([
      "combat_started",
      "combat_ended",
    ]);
    expect(result.turnorder[0]?.entries[0]).toEqual({
      name: "Goblin",
      value: 14,
      token_id: "tok-g",
    });
  });

  it("preserves unknown templates as other and counts them", () => {
    const result = parseRoll20({
      messages: [
        {
          id: "m-unknown",
          kind: "rollresult",
          text: "A custom result",
          outerHTML:
            '<div class="message rollresult"><div class="sheet-rolltemplate-future">A custom result</div></div>',
          roll: { formula: "1d20", dice: [{ sides: 20, value: 9 }], total: 9 },
        },
      ],
    });
    expect(result.messages[0]).toMatchObject({
      kind: "other",
      text: "A custom result",
      raw_ref: "m-unknown",
    });
    expect(result.qa.unrecognized_count).toBe(1);
    expect(result.qa.metrics["unrecognized_messages"]).toBe(1);
    expect(result.rolls[0]?.kind).toBe("other");
  });

  it("normalises archive markup and JSON fields without using timing", () => {
    const capture = {
      messages: [
        {
          id: "m1",
          seq: 1,
          who: "Ash",
          kind: "general",
          text: "Hello",
          t_wall_ms: 20,
          outer_html:
            '<div class="message general" data-messageid="m1"><span class="by">Ash:</span> Hello</div>',
        },
        {
          id: "m2",
          seq: 2,
          who: "Ash",
          kind: "rollresult",
          text: "",
          t_wall_ms: 30,
          roll: {
            formula: "1d20+5",
            dice: [{ sides: 20, value: 16 }],
            modifiers: 5,
            total: 21,
            kind: "attack",
          },
          outer_html:
            '<div class="message rollresult" data-messageid="m2"><span class="by">Ash:</span>' +
            '<div class="sheet-rolltemplate-atk"><div class="sheet-label">Attack</div>' +
            '<div class="inlinerollresult" title="Rolling 1d20+5"><div class="die d20">16</div><strong>21</strong></div>' +
            "</div></div>",
        },
      ],
    };
    const archive =
      '<div id="textchat">' +
      '<div class="message general" data-messageid="m1"><span class="by">Ash:</span> Hello</div>' +
      '<div class="message rollresult" data-messageid="m2"><span class="by">Ash:</span>' +
      '<div class="sheet-rolltemplate-atk"><div class="sheet-label">Attack</div>' +
      '<div class="inlinerollresult" title="Rolling 1d20+5"><div class="die d20">16</div><strong>21</strong></div>' +
      "</div></div></div>";
    const json = parseRoll20(capture);
    const html = parseRoll20(archive);
    const comparable = (result: ReturnType<typeof parseRoll20>) =>
      result.messages.map((message) =>
        Object.fromEntries(
          Object.entries(message).filter(([key]) => key !== "t_wall_ms" && key !== "t_mono_ms"),
        ),
      );
    expect(comparable(html)).toEqual(comparable(json));
    expect(normalizeRoll20Input(archive).source).toBe("html");
    expect(normalizeRoll20Input(JSON.stringify(capture)).source).toBe("json");
  });
});
