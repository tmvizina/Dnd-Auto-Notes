/**
 * Pure Roll20 capture normalisation and parsing.
 *
 * Roll20 does not expose a stable export format.  The browser capture keeps
 * the original message markup specifically so this module can be replayed as
 * its selectors evolve.  This parser therefore deliberately uses a small,
 * forgiving HTML scanner instead of a DOM or filesystem dependency.
 */

export type RollKind =
  "attack" | "damage" | "save" | "check" | "initiative" | "death_save" | "other";

export type AdvantageKind = "none" | "advantage" | "disadvantage";

export type ParsedMessageKind =
  "chat" | "emote" | "whisper" | "description" | "roll" | "system" | "turnorder" | "other";

export interface Roll20DieInput {
  readonly sides?: unknown;
  readonly value?: unknown;
  readonly v?: unknown;
  readonly dropped?: unknown;
  readonly drop?: unknown;
  readonly discarded?: unknown;
  readonly used?: unknown;
  readonly kept?: unknown;
}

export interface Roll20RollInput {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly who?: unknown;
  readonly player_id?: unknown;
  readonly formula?: unknown;
  readonly dice?: unknown;
  readonly modifiers?: unknown;
  readonly modifier?: unknown;
  readonly total?: unknown;
  readonly result?: unknown;
  readonly kind?: unknown;
  readonly advantage?: unknown;
  readonly used?: unknown;
  readonly used_result?: unknown;
  readonly target?: unknown;
  readonly template?: unknown;
  readonly rolls?: unknown;
}

export interface Roll20CaptureMessage {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly t_wall_ms?: unknown;
  readonly t_mono_ms?: unknown;
  readonly who?: unknown;
  readonly player_id?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly to?: unknown;
  readonly outerHTML?: unknown;
  readonly outer_html?: unknown;
  readonly formula?: unknown;
  readonly dice?: unknown;
  readonly modifiers?: unknown;
  readonly total?: unknown;
  readonly roll?: unknown;
  readonly rolls?: unknown;
  readonly entries?: unknown;
  readonly marker?: unknown;
  readonly turnorder?: unknown;
}

export interface Roll20TurnorderInput {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly t_wall_ms?: unknown;
  readonly t_mono_ms?: unknown;
  readonly entries?: unknown;
  readonly marker?: unknown;
  readonly who?: unknown;
  readonly outerHTML?: unknown;
  readonly outer_html?: unknown;
}

export interface Roll20Capture {
  readonly version?: unknown;
  readonly captured_at?: unknown;
  readonly mode?: unknown;
  readonly game_id?: unknown;
  readonly messages?: unknown;
  readonly turnorder_events?: unknown;
}

export interface NormalizedRoll20Message {
  readonly source: "json" | "html";
  readonly source_index: number;
  /** The id is retained exactly as Roll20 supplied it; null means absent. */
  readonly id: string | null;
  readonly seq: number | null;
  readonly t_wall_ms: number | null;
  readonly t_mono_ms: number | null;
  readonly who: string | null;
  readonly player_id: string | null;
  readonly source_kind: string | null;
  readonly text: string;
  /** Unprocessed text or markup, useful when a message is not understood. */
  readonly raw_text: string;
  readonly to: string | null;
  readonly raw: string;
  readonly roll: Record<string, unknown> | null;
  readonly turnorder: NormalizedTurnorder | null;
}

export interface NormalizedTurnorder {
  readonly id: string | null;
  readonly seq: number | null;
  readonly t_wall_ms: number | null;
  readonly t_mono_ms: number | null;
  readonly entries: readonly TurnOrderEntry[];
  readonly marker: string | null;
  readonly who: string | null;
  readonly raw: string;
}

export interface NormalizedRoll20Input {
  readonly source: "json" | "html";
  readonly messages: readonly NormalizedRoll20Message[];
  readonly turnorder_events: readonly NormalizedTurnorder[];
}

export interface TurnOrderEntry {
  readonly name: string;
  readonly value: number | null;
  readonly token_id: string | null;
}

export interface RollData {
  readonly id: string | null;
  readonly seq: number;
  readonly who: string | null;
  readonly player_id: string | null;
  readonly formula: string;
  readonly dice: readonly RollDie[];
  readonly modifiers: number;
  readonly total: number | null;
  readonly kind: RollKind;
  readonly roll_kind: RollKind;
  readonly advantage: AdvantageKind;
  /** The d20 result used after advantage/disadvantage selection. */
  readonly used: number | null;
  readonly used_result: number | null;
  readonly target: string | null;
  readonly npc_mentions: readonly string[];
  readonly raw_ref: string;
}

export interface RollDie {
  readonly sides: number | null;
  readonly value: number;
  readonly dropped: boolean;
}

export interface ParsedMessageBase {
  readonly kind: ParsedMessageKind;
  /** Alias useful to callers that use `type` as the union discriminator. */
  readonly type: ParsedMessageKind;
  readonly id: string | null;
  readonly seq: number;
  readonly who: string | null;
  readonly player_id: string | null;
  readonly t_wall_ms: number | null;
  readonly t_mono_ms: number | null;
  readonly text: string;
  /** The exact source message id, or a local pointer when the id was absent. */
  readonly raw_ref: string;
  readonly raw_text: string;
  readonly raw: string;
  readonly npc_mentions: readonly string[];
}

export interface ChatRecord extends ParsedMessageBase {
  readonly kind: "chat";
  readonly type: "chat";
}

export interface EmoteRecord extends ParsedMessageBase {
  readonly kind: "emote";
  readonly type: "emote";
}

export interface WhisperRecord extends ParsedMessageBase {
  readonly kind: "whisper";
  readonly type: "whisper";
  readonly to: string | null;
}

export interface DescriptionRecord extends ParsedMessageBase {
  readonly kind: "description";
  readonly type: "description";
}

export interface RollRecord extends ParsedMessageBase {
  readonly kind: "roll";
  readonly type: "roll";
  readonly formula: string;
  readonly dice: readonly RollDie[];
  readonly modifiers: number;
  readonly total: number | null;
  /** Roll template kind.  `kind` remains the union discriminator. */
  readonly roll_kind: RollKind;
  readonly advantage: AdvantageKind;
  readonly used: number | null;
  readonly used_result: number | null;
  readonly target: string | null;
  readonly roll: RollData;
}

export interface SystemRecord extends ParsedMessageBase {
  readonly kind: "system";
  readonly type: "system";
}

export type CombatMarkerKind = "combat_started" | "combat_ended";

export interface TurnorderRecord extends ParsedMessageBase {
  readonly kind: "turnorder";
  readonly type: "turnorder";
  readonly entries: readonly TurnOrderEntry[];
  readonly marker: "combat_started" | "combat_ended" | "changed";
}

export interface OtherRecord extends ParsedMessageBase {
  readonly kind: "other";
  readonly type: "other";
  /** Roll details are retained when an unknown template still looked like a roll. */
  readonly roll?: RollData;
  readonly template?: string;
}

export type ParsedRoll20Message =
  | ChatRecord
  | EmoteRecord
  | WhisperRecord
  | DescriptionRecord
  | RollRecord
  | SystemRecord
  | TurnorderRecord
  | OtherRecord;

export interface CombatMarker {
  readonly kind: CombatMarkerKind;
  readonly seq: number;
  readonly id: string | null;
  readonly raw_ref: string;
}

export interface Roll20QaEntry {
  readonly code: "ROLL20_UNRECOGNIZED";
  readonly severity: "warning";
  readonly message: string;
  readonly subject?: string;
}

export interface Roll20QaReport {
  readonly stage: "roll20";
  readonly entries: readonly Roll20QaEntry[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly unrecognized_count: number;
  readonly unknown_count: number;
  readonly other_count: number;
  readonly unrecognized: number;
  readonly unknown: number;
}

export interface Roll20ParseResult {
  readonly normalized: NormalizedRoll20Input;
  readonly messages: readonly ParsedRoll20Message[];
  /** Alias retained for stage callers that call the stream `records`. */
  readonly records: readonly ParsedRoll20Message[];
  /** Flattened roll payloads, convenient for intake/timeline stages. */
  readonly rolls: readonly RollData[];
  readonly roll_records: readonly RollRecord[];
  readonly turnorder: readonly TurnorderRecord[];
  readonly turnorder_events: readonly TurnorderRecord[];
  readonly combat_markers: readonly CombatMarker[];
  readonly qa: Roll20QaReport;
  readonly unrecognized_count: number;
  readonly unknown_count: number;
  readonly unrecognized: number;
}

interface HtmlElement {
  readonly start: number;
  readonly end: number;
  readonly open_end: number;
  readonly tag: string;
  readonly open: string;
  readonly inner: string;
  readonly raw: string;
  readonly attrs: Readonly<Record<string, string>>;
}

interface HtmlMessageCandidate {
  readonly element: HtmlElement;
  readonly event: NormalizedTurnorder | null;
}

interface RollDetails {
  readonly formula: string;
  readonly dice: readonly RollDie[];
  readonly modifiers: number;
  readonly total: number | null;
  readonly kind: RollKind;
  readonly advantage: AdvantageKind;
  readonly used: number | null;
  readonly npc_mentions: readonly string[];
  readonly template: string | null;
  readonly unknown_template: boolean;
  readonly target: string | null;
}

const KNOWN_KINDS = new Set<ParsedMessageKind>([
  "chat",
  "emote",
  "whisper",
  "description",
  "roll",
  "system",
  "turnorder",
]);

const KNOWN_TEMPLATES = new Set(["atk", "dmg", "simple", "npcaction"]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const GENERIC_LABELS = new Set([
  "attack",
  "damage",
  "to hit",
  "hit",
  "initiative",
  "saving throw",
  "save",
  "check",
  "ability check",
  "death save",
  "result",
  "total",
  "action",
  "weapon",
  "spell",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function cleanString(value: unknown): string | null {
  const text = asString(value)?.trim() ?? "";
  return text === "" ? null : text;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asInteger(value: unknown): number | null {
  const number = asFiniteNumber(value);
  return number === null ? null : Math.trunc(number);
}

function numberOrSum(value: unknown): number | null {
  if (Array.isArray(value)) {
    const numbers = value.map(asFiniteNumber).filter((number): number is number => number !== null);
    return numbers.length === 0 ? null : numbers.reduce((sum, number) => sum + number, 0);
  }
  return asFiniteNumber(value);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#(\d+)|#x([\da-f]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      const named: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " ",
      };
      const namedValue = named[entity.toLowerCase()];
      if (namedValue !== undefined) return namedValue;
      const parsed = decimal
        ? Number.parseInt(decimal, 10)
        : hexadecimal === undefined
          ? Number.NaN
          : Number.parseInt(hexadecimal, 16);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : entity;
    },
  );
}

function textFromHtml(value: string): string {
  const withBreaks = value
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/p\s*>/gi, "\n")
    .replace(/<\s*(?:script|style)[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeHtml(withBreaks).replace(/\s+/g, " ").trim();
}

function parseAttributes(open: string): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {};
  const body = open.replace(/^<[^\s>]+/u, "").replace(/\/?>\s*$/u, "");
  const expression = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(body)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "") continue;
    attrs[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function scanHtml(value: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  const stack: Array<{ tag: string; start: number; open_end: number; open: string }> = [];
  const tags = /<\/?([A-Za-z][\w:-]*)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(value)) !== null) {
    const full = match[0];
    const tag = (match[1] ?? "").toLowerCase();
    if (full.startsWith("</")) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index]?.tag !== tag) index -= 1;
      if (index < 0) continue;
      const opening = stack[index];
      stack.splice(index, 1);
      if (opening === undefined) continue;
      const end = tags.lastIndex;
      elements.push({
        start: opening.start,
        end,
        open_end: opening.open_end,
        tag,
        open: opening.open,
        inner: value.slice(opening.open_end, match.index),
        raw: value.slice(opening.start, end),
        attrs: parseAttributes(opening.open),
      });
      continue;
    }
    if (VOID_TAGS.has(tag) || /\/\s*>$/u.test(full)) continue;
    stack.push({ tag, start: match.index, open_end: tags.lastIndex, open: full });
  }
  return elements.sort((left, right) => left.start - right.start || right.end - left.end);
}

function classTokens(element: HtmlElement): string[] {
  return (element.attrs["class"] ?? "").split(/\s+/u).filter(Boolean);
}

function hasClass(element: HtmlElement, pattern: RegExp): boolean {
  return pattern.test(classTokens(element).join(" "));
}

function attr(element: HtmlElement | null, ...names: string[]): string | null {
  if (element === null) return null;
  for (const name of names) {
    const value = element.attrs[name.toLowerCase()];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function firstTextElement(elements: readonly HtmlElement[], pattern: RegExp): HtmlElement | null {
  return elements.find((element) => pattern.test(classTokens(element).join(" "))) ?? null;
}

function idOrNull(value: unknown): string | null {
  const text = cleanString(value);
  return text;
}

function messageRef(id: string | null, source: "json" | "html", index: number): string {
  // The fallback is a review pointer, never an id.  In particular, no value
  // is written into ParsedMessageBase.id when Roll20 omitted its id.
  return id ?? `${source}:message:${String(index)}`;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  const text = decodeHtml(value).trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function entryFromValue(value: unknown): TurnOrderEntry | null {
  const object = asRecord(value);
  if (object === null) return null;
  const name = cleanString(object["name"] ?? object["n"]) ?? "";
  if (name === "") return null;
  const valueNumber = asFiniteNumber(object["value"] ?? object["pr"]);
  const token = cleanString(
    object["token_id"] ?? object["tokenId"] ?? object["id"] ?? object["tokid"],
  );
  return { name, value: valueNumber, token_id: token };
}

function entriesFromValue(value: unknown): TurnOrderEntry[] {
  if (Array.isArray(value))
    return value.map(entryFromValue).filter((entry): entry is TurnOrderEntry => entry !== null);
  const parsed = typeof value === "string" ? parseJson(value) : null;
  return parsed === null ? [] : entriesFromValue(parsed);
}

function markerFromValue(value: unknown): string | null {
  const marker = cleanString(value)?.toLowerCase() ?? null;
  return marker === null ? null : marker;
}

function normalizedTurnorder(
  value: unknown,
  source: "json" | "html",
  index: number,
  rawFallback = "",
): NormalizedTurnorder | null {
  const object = asRecord(value);
  if (object === null) return null;
  const id = idOrNull(object["id"]);
  const entries = entriesFromValue(object["entries"] ?? object["turnorder"] ?? []);
  return {
    id,
    seq: asInteger(object["seq"]),
    t_wall_ms: asFiniteNumber(object["t_wall_ms"] ?? object["t_wallclock"]),
    t_mono_ms: asFiniteNumber(object["t_mono_ms"] ?? object["t_monotonic"]),
    entries,
    marker: markerFromValue(object["marker"]),
    who: cleanString(object["who"]),
    raw: cleanString(object["outerHTML"] ?? object["outer_html"]) ?? rawFallback,
  };
}

function sourceKind(value: unknown): string | null {
  return cleanString(value)?.toLowerCase() ?? null;
}

function normalizedMessageFromObject(
  object: Record<string, unknown>,
  source: "json" | "html",
  index: number,
): NormalizedRoll20Message {
  const raw = cleanString(object["outerHTML"] ?? object["outer_html"]) ?? "";
  const text = asString(object["text"]) ?? "";
  const nestedRoll = asRecord(object["roll"]);
  const topLevelRoll =
    object["formula"] !== undefined ||
    object["dice"] !== undefined ||
    object["total"] !== undefined ||
    object["modifiers"] !== undefined ||
    object["kind"] === "rollresult"
      ? object
      : null;
  const roll = nestedRoll ?? topLevelRoll;
  const ownEntries = object["entries"] ?? object["turnorder"];
  const turnorder =
    sourceKind(object["kind"]) === "turnorder" || ownEntries !== undefined
      ? normalizedTurnorder(
          {
            ...object,
            entries: ownEntries,
            outerHTML: raw,
          },
          source,
          index,
          raw,
        )
      : null;
  return {
    source,
    source_index: index,
    id: idOrNull(object["id"]),
    seq: asInteger(object["seq"]),
    t_wall_ms: asFiniteNumber(object["t_wall_ms"] ?? object["t_wallclock"]),
    t_mono_ms: asFiniteNumber(object["t_mono_ms"] ?? object["t_monotonic"]),
    who: cleanString(object["who"]),
    player_id: cleanString(object["player_id"] ?? object["playerId"]),
    source_kind: sourceKind(object["kind"]),
    text,
    raw_text: text,
    to: cleanString(object["to"] ?? object["whisper_to"] ?? object["target"]),
    raw,
    roll,
    turnorder,
  };
}

function topLevelHtmlMessages(html: string): HtmlMessageCandidate[] {
  const elements = scanHtml(html);
  const root = elements.find((element) => element.attrs["id"]?.toLowerCase() === "textchat");
  const inRoot =
    root === undefined
      ? elements
      : elements.filter((element) => element.start > root.start && element.end < root.end);
  const candidates = inRoot.filter(
    (element) =>
      hasClass(element, /(?:^|\s)message(?:\s|$)/iu) ||
      attr(element, "data-messageid", "data-message-id") !== null,
  );
  const outermost = candidates.filter(
    (candidate) =>
      !candidates.some(
        (parent) =>
          parent !== candidate && parent.start < candidate.start && parent.end >= candidate.end,
      ),
  );
  return outermost.map((element) => ({ element, event: htmlTurnorder(element, elements) }));
}

function htmlWho(element: HtmlElement, descendants: readonly HtmlElement[]): string | null {
  const speaker = firstTextElement(descendants, /(?:^|\s)(?:by|speaker)(?:\s|$)/iu);
  if (speaker !== null) {
    const value = attr(speaker, "data-who", "data-speaker") ?? textFromHtml(speaker.inner);
    const clean = cleanString(value)?.replace(/:\s*$/u, "") ?? null;
    if (clean !== null) return clean;
  }
  return cleanString(attr(element, "data-who", "data-speaker"));
}

function removeSpeakerPrefix(text: string, who: string | null, emote: boolean): string {
  if (who === null) return text;
  const escaped = who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = new RegExp(`^${escaped}\\s*:?\\s*`, "iu");
  return emote ? text.replace(prefix, "").trim() : text.replace(prefix, "").trim();
}

function htmlToNormalizedMessage(
  candidate: HtmlMessageCandidate,
  index: number,
): NormalizedRoll20Message {
  const { element, event } = candidate;
  const descendants = scanHtml(element.raw);
  const who = htmlWho(element, descendants);
  const playerNode = descendants.find(
    (descendant) =>
      attr(descendant, "data-playerid", "data-player-id", "data-player_id", "data-player") !== null,
  );
  const rawClass = classTokens(element).join(" ").toLowerCase();
  const speakerStripped = removeSpeakerPrefix(
    textFromHtml(element.inner),
    who,
    rawClass.includes("emote"),
  );
  const whisper = speakerStripped.match(/^\(\s*whisper(?:ed)?\s+to\s+([^)]+)\)\s*(.*)$/iu);
  const text = whisper?.[2]?.trim() ?? speakerStripped;
  const sourceKindValue = rawClass.includes("turnorder")
    ? "turnorder"
    : rawClass.includes("rollresult") ||
        rawClass.includes("rolltemplate") ||
        /\[\[[\s\S]*?\]\]|(?:\/r|\/roll)\s+/iu.test(element.raw)
      ? "rollresult"
      : (rawClass.match(/(?:^|\s)(whisper|emote|desc|description|system|general)(?:\s|$)/u)?.[1] ??
        (rawClass.trim() === "message" ? "general" : "other"));
  const turnorder = event;
  return {
    source: "html",
    source_index: index,
    id: idOrNull(attr(element, "data-messageid", "data-message-id")),
    seq: asInteger(attr(element, "data-seq", "data-message-seq")),
    t_wall_ms: asFiniteNumber(
      attr(element, "data-timestamp", "data-time", "data-wall-ms", "data-wallclock", "timestamp"),
    ),
    t_mono_ms: null,
    who,
    player_id:
      cleanString(
        attr(element, "data-playerid", "data-player-id", "data-player_id", "data-player"),
      ) ??
      cleanString(
        attr(
          playerNode ?? null,
          "data-playerid",
          "data-player-id",
          "data-player_id",
          "data-player",
        ),
      ),
    source_kind: sourceKindValue,
    text,
    raw_text: text,
    to:
      cleanString(attr(element, "data-to", "data-whisper-to")) ??
      cleanString(
        attr(
          descendants.find(
            (descendant) => attr(descendant, "data-to", "data-whisper-to") !== null,
          ) ?? null,
          "data-to",
          "data-whisper-to",
        ),
      ) ??
      whisper?.[1]?.trim() ??
      null,
    raw: element.raw,
    roll: null,
    turnorder,
  };
}

function htmlTurnorder(
  element: HtmlElement,
  descendants: readonly HtmlElement[],
): NormalizedTurnorder | null {
  const classes = classTokens(element).join(" ").toLowerCase();
  const encoded = attr(
    element,
    "data-turnorder",
    "data-order",
    "data-entries",
    "data-turnorder-events",
  );
  const parsed = encoded === null ? null : parseJson(encoded);
  const itemElements = descendants.filter(
    (descendant) =>
      descendant !== element &&
      (descendant.tag === "li" ||
        hasClass(descendant, /turnorder(?:item|-item)|turnorder-entry/iu)),
  );
  const entries =
    parsed !== null
      ? entriesFromValue(parsed)
      : itemElements
          .map((item) => {
            const itemDescendants = scanHtml(item.raw);
            const nameNode = firstTextElement(
              itemDescendants,
              /(?:^|\s)(?:name|token-name|turnorder-name)(?:\s|$)/iu,
            );
            const valueNode = firstTextElement(
              itemDescendants,
              /(?:^|\s)(?:pr|initiative|turnorder-value|turnorder-pr)(?:\s|$)/iu,
            );
            const name =
              cleanString(
                attr(item, "data-name") ??
                  (nameNode === null ? textFromHtml(item.inner) : textFromHtml(nameNode.inner)),
              ) ?? "";
            const value = asFiniteNumber(
              attr(item, "data-value", "data-pr") ??
                (valueNode === null
                  ? textFromHtml(item.inner).match(/-?\d+(?:\.\d+)?/u)?.[0]
                  : textFromHtml(valueNode.inner)),
            );
            const token = cleanString(
              attr(item, "data-tokid", "data-tokenid", "data-token-id", "data-id"),
            );
            return name === "" ? null : { name, value, token_id: token };
          })
          .filter((entry): entry is TurnOrderEntry => entry !== null);
  if (!classes.includes("turnorder") && encoded === null) return null;
  return {
    id: idOrNull(attr(element, "data-messageid", "data-message-id")),
    seq: asInteger(attr(element, "data-seq", "data-message-seq")),
    t_wall_ms: asFiniteNumber(
      attr(element, "data-timestamp", "data-time", "data-wall-ms", "data-wallclock", "timestamp"),
    ),
    t_mono_ms: null,
    entries,
    marker: markerFromValue(attr(element, "data-marker")),
    who: htmlWho(element, descendants),
    raw: element.raw,
  };
}

function normalizeCaptureObject(value: Record<string, unknown>): NormalizedRoll20Input {
  const rawMessages = Array.isArray(value["messages"]) ? value["messages"] : [];
  const messages: NormalizedRoll20Message[] = [];
  for (const [index, item] of rawMessages.entries()) {
    const object = asRecord(item);
    if (object === null) {
      messages.push({
        source: "json",
        source_index: index,
        id: null,
        seq: null,
        t_wall_ms: null,
        t_mono_ms: null,
        who: null,
        player_id: null,
        source_kind: null,
        text: asString(item) ?? "",
        raw_text: asString(item) ?? "",
        to: null,
        raw: "",
        roll: null,
        turnorder: null,
      });
      continue;
    }
    messages.push(normalizedMessageFromObject(object, "json", index));
  }

  const events: NormalizedTurnorder[] = [];
  const eventIds = new Set<string>();
  for (const message of messages) {
    if (message.turnorder !== null) {
      events.push(message.turnorder);
      if (message.turnorder.id !== null) eventIds.add(message.turnorder.id);
    }
  }
  const rawEvents = Array.isArray(value["turnorder_events"]) ? value["turnorder_events"] : [];
  for (const [index, item] of rawEvents.entries()) {
    const event = normalizedTurnorder(item, "json", index);
    if (event === null || (event.id !== null && eventIds.has(event.id))) continue;
    events.push(event);
    if (event.id !== null) eventIds.add(event.id);
    const sourceIndex = messages.length + index;
    messages.push({
      source: "json",
      source_index: sourceIndex,
      id: event.id,
      seq: event.seq,
      t_wall_ms: event.t_wall_ms,
      t_mono_ms: event.t_mono_ms,
      who: event.who,
      player_id: null,
      source_kind: "turnorder",
      text: "Turn order updated",
      raw_text: "Turn order updated",
      to: null,
      raw: event.raw,
      roll: null,
      turnorder: event,
    });
  }
  return {
    source: "json",
    messages: mergeByTiming(messages),
    turnorder_events: events,
  };
}

function normalizeArchive(html: string): NormalizedRoll20Input {
  const candidates = topLevelHtmlMessages(html);
  const messages =
    candidates.length > 0
      ? candidates.map((candidate, index) => htmlToNormalizedMessage(candidate, index))
      : html.trim() === ""
        ? []
        : [
            {
              source: "html" as const,
              source_index: 0,
              id: null,
              seq: null,
              t_wall_ms: null,
              t_mono_ms: null,
              who: null,
              player_id: null,
              source_kind: null,
              text: textFromHtml(html),
              raw_text: html,
              to: null,
              raw: html,
              roll: null,
              turnorder: null,
            } satisfies NormalizedRoll20Message,
          ];
  const candidateRaws = new Set(candidates.map((candidate) => candidate.element.raw));
  const standaloneEvents = scanHtml(html)
    .filter((element) => {
      const isTracker =
        element.attrs["id"]?.toLowerCase() === "turnorder" ||
        hasClass(element, /(?:^|\s)turnorder(?:\s|$)/iu) ||
        attr(element, "data-turnorder", "data-order", "data-entries") !== null;
      return isTracker && !candidateRaws.has(element.raw);
    })
    .map((element) => htmlTurnorder(element, scanHtml(element.raw)))
    .filter((event): event is NormalizedTurnorder => event !== null);
  for (const [offset, event] of standaloneEvents.entries()) {
    messages.push({
      source: "html",
      source_index: messages.length + offset,
      id: event.id,
      seq: event.seq,
      t_wall_ms: event.t_wall_ms,
      t_mono_ms: event.t_mono_ms,
      who: event.who,
      player_id: null,
      source_kind: "turnorder",
      text: "Turn order updated",
      raw_text: "Turn order updated",
      to: null,
      raw: event.raw,
      roll: null,
      turnorder: event,
    });
  }
  const events = messages
    .map((message) => message.turnorder)
    .filter((event): event is NormalizedTurnorder => event !== null);
  return { source: "html", messages: mergeByTiming(messages), turnorder_events: events };
}

function mergeByTiming(messages: readonly NormalizedRoll20Message[]): NormalizedRoll20Message[] {
  return [...messages].sort((left, right) => {
    const leftTime = left.t_wall_ms;
    const rightTime = right.t_wall_ms;
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime)
      return leftTime - rightTime;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime === null && rightTime !== null) return 1;
    if (left.seq !== null && right.seq !== null && left.seq !== right.seq)
      return left.seq - right.seq;
    if (left.seq !== null && right.seq === null) return -1;
    if (left.seq === null && right.seq !== null) return 1;
    return left.source_index - right.source_index;
  });
}

function inputHtml(value: unknown): string | null {
  if (typeof value === "string") return value;
  const object = asRecord(value);
  if (object === null) return null;
  return asString(object["html"] ?? object["archive_html"] ?? object["chat_archive_html"]);
}

/**
 * Converts either a capture object, a JSON string, or a saved archive HTML
 * string into the parser's one internal message representation.
 */
export function normalizeRoll20Input(input: unknown): NormalizedRoll20Input {
  if (Array.isArray(input)) return normalizeCaptureObject({ messages: input });
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const object = asRecord(parsed);
        if (object !== null) return normalizeCaptureObject(object);
        if (Array.isArray(parsed)) return normalizeCaptureObject({ messages: parsed });
      } catch {
        // Treat malformed JSON as archive text so it is retained as `other`.
      }
    }
    return normalizeArchive(input);
  }
  const object = asRecord(input);
  if (object !== null) {
    const html = inputHtml(object);
    if (html !== null) return normalizeArchive(html);
    return normalizeCaptureObject(object);
  }
  return normalizeArchive(asString(input) ?? "");
}

function normalizedKind(message: NormalizedRoll20Message): ParsedMessageKind {
  const source = message.source_kind;
  if (source === null) {
    if (
      /sheet-rolltemplate-|\[\[[\s\S]*?\]\]|(?:\/r|\/roll)\s+/iu.test(
        message.raw + " " + message.text,
      )
    )
      return "roll";
    return "other";
  }
  if (
    (source === "general" || source === "chat" || source === "message") &&
    /sheet-rolltemplate-|\[\[[\s\S]*?\]\]|(?:\/r|\/roll)\s+/iu.test(
      message.raw + " " + message.text,
    )
  ) {
    return "roll";
  }
  if (source === "general" || source === "chat" || source === "message") return "chat";
  if (source === "desc" || source === "description" || source === "narration") return "description";
  if (source === "rollresult" || source === "roll" || source === "inline") return "roll";
  if (source === "turnorder") return "turnorder";
  if (source === "whisper" || source === "emote" || source === "system") return source;
  if (KNOWN_KINDS.has(source as ParsedMessageKind)) return source as ParsedMessageKind;
  if (
    /sheet-rolltemplate-|\[\[[\s\S]*?\]\]|(?:\/r|\/roll)\s+/iu.test(
      message.raw + " " + message.text,
    )
  ) {
    return "roll";
  }
  return "other";
}

function htmlDescendants(raw: string): HtmlElement[] {
  return scanHtml(raw);
}

function extractTemplate(raw: string): string | null {
  const match = raw.match(/sheet-rolltemplate-([\w-]+)/iu);
  return match?.[1]?.toLowerCase() ?? null;
}

function numberFromText(value: string): number | null {
  const match = value.match(/-?\d+(?:\.\d+)?/u);
  return match === null ? null : asFiniteNumber(match[0]);
}

function formulaFromTitle(title: string): string | null {
  const rolling = title.match(/^\s*rolling\s+(.+?)(?:\s*=|$)/iu)?.[1];
  if (rolling !== undefined && rolling.trim() !== "") return rolling.trim();
  const inline = title.match(/\[\[\s*([\s\S]*?)\s*\]\]/u)?.[1];
  if (inline !== undefined && inline.trim() !== "") return inline.trim();
  const beforeEquals = title.split("=")[0]?.trim() ?? "";
  return beforeEquals === "" ? null : beforeEquals;
}

function formulaFromRaw(raw: string, text: string): string | null {
  const explicit = raw.match(
    /(?:data-formula|data-rollformula|data-expression)\s*=\s*["']([^"']+)["']/iu,
  )?.[1];
  if (explicit !== undefined && explicit.trim() !== "") return decodeHtml(explicit).trim();
  const inline = raw.match(/\[\[\s*([\s\S]*?)\s*\]\]/u)?.[1];
  if (inline !== undefined && inline.trim() !== "") return decodeHtml(inline).trim();
  const slash = (text + " " + textFromHtml(raw)).match(
    /(?:\/r|\/roll)\s+([^\n<]+?)(?:\s*=|$)/iu,
  )?.[1];
  if (slash !== undefined && slash.trim() !== "") return slash.trim();
  const title = raw.match(/\btitle\s*=\s*["']([^"']+)["']/iu)?.[1];
  return title === undefined ? null : formulaFromTitle(decodeHtml(title));
}

function formulaSides(formula: string): number[] {
  const sides: number[] = [];
  const expression = /(\d+)\s*d\s*(\d+)/giu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(formula)) !== null) {
    const count = Number(match[1]);
    const dieSides = Number(match[2]);
    if (!Number.isFinite(count) || !Number.isFinite(dieSides) || count < 1 || count > 100) continue;
    for (let index = 0; index < count; index += 1) sides.push(dieSides);
  }
  return sides;
}

function modifiersFromFormula(formula: string): number {
  const withoutDice = formula.replace(/\d+\s*d\s*\d+(?:\s*k[hl]\s*\d+)?/giu, "");
  const matches = withoutDice.match(/[+-]\s*\d+(?:\.\d+)?/gu) ?? [];
  return matches.reduce((sum, value) => sum + Number(value.replace(/\s+/gu, "")), 0);
}

function parseDataDice(value: unknown, sides: readonly number[]): RollDie[] {
  const values: RollDie[] = [];
  const source = Array.isArray(value) ? value : [];
  for (const [index, item] of source.entries()) {
    if (typeof item === "number" || typeof item === "string") {
      const number = asFiniteNumber(item);
      if (number !== null)
        values.push({ sides: sides[index] ?? null, value: number, dropped: false });
      continue;
    }
    const object = asRecord(item);
    if (object === null) continue;
    const number = asFiniteNumber(
      object["value"] ?? object["v"] ?? object["result"] ?? object["die"],
    );
    if (number === null) continue;
    const dieSides = asInteger(object["sides"] ?? object["size"] ?? object["d"]);
    const dropped =
      asBoolean(object["dropped"] ?? object["drop"] ?? object["discarded"]) ||
      object["used"] === false ||
      object["kept"] === false;
    values.push({ sides: dieSides ?? sides[index] ?? null, value: number, dropped });
  }
  return values;
}

function parseTitleDice(title: string, sides: readonly number[]): RollDie[] {
  const result: RollDie[] = [];
  const groups = title.match(/\(([-+\d.,\s]+)\)/gu) ?? [];
  for (const group of groups) {
    const numbers = group.match(/-?\d+(?:\.\d+)?/gu) ?? [];
    for (const number of numbers) {
      const value = asFiniteNumber(number);
      if (value !== null)
        result.push({ sides: sides[result.length] ?? null, value, dropped: false });
    }
  }
  return result;
}

function htmlDice(raw: string, formula: string): RollDie[] {
  const elements = htmlDescendants(raw);
  const sides = formulaSides(formula);
  const dice: RollDie[] = [];
  for (const element of elements) {
    const classes = classTokens(element).join(" ");
    const explicitDie =
      hasClass(element, /(?:^|\s)die(?:\s|$)/iu) || attr(element, "data-die") !== null;
    const basicDie =
      hasClass(element, /(?:^|\s)(?:basicdiceroll|diceroll)(?:\s|$)/iu) &&
      !/^\s*[+-]/u.test(textFromHtml(element.inner));
    if (!explicitDie && !basicDie) continue;
    const value = asFiniteNumber(
      attr(element, "data-die", "data-value", "data-result") ??
        numberFromText(textFromHtml(element.inner)),
    );
    if (value === null) continue;
    const classSides = classes.match(/(?:^|\s)d(\d+)(?:\s|$)/iu)?.[1];
    const dieSides =
      asInteger(attr(element, "data-sides", "data-size")) ??
      asInteger(classSides) ??
      sides[dice.length] ??
      null;
    const dropped = /(?:dropped|discarded|drop)/iu.test(
      classes + " " + (attr(element, "data-dropped") ?? ""),
    );
    dice.push({ sides: dieSides, value, dropped });
  }
  const titles = elements
    .map((element) => attr(element, "title", "data-title", "aria-label"))
    .filter((title): title is string => title !== null);
  for (const title of titles) {
    if (dice.length > 0 && !title.includes("(")) continue;
    const titleDice = parseTitleDice(title, sides);
    for (const die of titleDice) dice.push(die);
  }
  if (dice.length === 0) {
    const allNumbers = raw.match(/data-die\s*=\s*["'](-?\d+(?:\.\d+)?)["']/giu) ?? [];
    for (const item of allNumbers) {
      const value = numberFromText(item);
      if (value !== null) dice.push({ sides: sides[dice.length] ?? null, value, dropped: false });
    }
  }
  return dice;
}

function explicitRollObject(message: NormalizedRoll20Message): Record<string, unknown> {
  const object = message.roll;
  if (object !== null) return object;
  return {};
}

function inputFormula(
  message: NormalizedRoll20Message,
  roll: Record<string, unknown>,
): string | null {
  const direct = cleanString(roll["formula"] ?? roll["expression"]);
  if (direct !== null) return direct;
  return formulaFromRaw(message.raw, message.text);
}

function explicitKind(value: unknown): RollKind | null {
  const normalized =
    cleanString(value)
      ?.toLowerCase()
      .replace(/[\s-]+/gu, "_") ?? null;
  return normalized !== null &&
    ["attack", "damage", "save", "check", "initiative", "death_save", "other"].includes(normalized)
    ? (normalized as RollKind)
    : null;
}

function inferRollKind(template: string | null, text: string, explicit: RollKind | null): RollKind {
  if (explicit !== null) return explicit;
  const lower = text.toLowerCase();
  if (template === "dmg") return "damage";
  if (template === "atk") return "attack";
  if (template === "simple" || template === "npcaction") {
    if (/death\s*save|death_save/iu.test(lower)) return "death_save";
    if (lower.includes("initiative")) return "initiative";
    if (/saving\s*throw|\bsave\b/iu.test(lower)) return "save";
    if (/\bcheck\b|perception|athletics|acrobatics|insight|investigation/iu.test(lower))
      return "check";
    if (/damage/iu.test(lower)) return "damage";
    if (/attack|to\s*hit|melee|ranged/iu.test(lower)) return "attack";
  }
  if (/death\s*save|death_save/iu.test(lower)) return "death_save";
  if (lower.includes("initiative")) return "initiative";
  if (/saving\s*throw|\bsave\b/iu.test(lower)) return "save";
  if (/\bcheck\b|perception|athletics|acrobatics|insight|investigation/iu.test(lower))
    return "check";
  if (/damage/iu.test(lower)) return "damage";
  if (/attack|to\s*hit/iu.test(lower)) return "attack";
  return "other";
}

function targetFromRoll(roll: Record<string, unknown>, text: string, raw = ""): string | null {
  const direct = cleanString(
    roll["target"] ?? roll["target_name"] ?? roll["npc"] ?? roll["creature"],
  );
  if (direct !== null) return direct;
  const markupTarget =
    raw.match(/data-(?:target|npc|creature)\s*=\s*["']([^"']+)["']/iu)?.[1] ??
    raw.match(/class=["'][^"']*target[^"']*["'][^>]*>([\s\S]*?)<\//iu)?.[1];
  if (markupTarget !== undefined)
    return cleanString(textFromHtml(markupTarget)) ?? cleanString(markupTarget);
  return (
    text.match(/(?:target|npc|creature|enemy|opponent)\s*[:=]\s*([^,;|]+)/iu)?.[1]?.trim() ?? null
  );
}

function npcMentions(text: string, who: string | null, explicitTarget: string | null): string[] {
  const values: string[] = [];
  const add = (candidate: string): void => {
    const normalized = candidate
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/[.,:;!?]+$/u, "");
    const withoutArticle = normalized.replace(/^(?:the|a|an)\s+/iu, "");
    if (withoutArticle === "" || GENERIC_LABELS.has(withoutArticle.toLowerCase())) return;
    if (who !== null && withoutArticle.toLowerCase() === who.toLowerCase()) return;
    if (!values.some((value) => value.toLowerCase() === withoutArticle.toLowerCase()))
      values.push(withoutArticle);
  };
  if (explicitTarget !== null) add(explicitTarget);
  const labelled = /(?:target|npc|creature|enemy|opponent)\s*[:=]\s*([^,;|]+)/giu;
  let match: RegExpExecArray | null;
  while ((match = labelled.exec(text)) !== null) {
    if (match[1] !== undefined) add(match[1]);
  }
  const proper = /\b([A-Z][\p{L}\p{M}\d'’.-]*(?:\s+[A-Z][\p{L}\p{M}\d'’.-]*)+)\b/gu;
  while ((match = proper.exec(text)) !== null) {
    if (match[1] !== undefined) add(match[1]);
  }
  const afterArticle = /\b(?:the|a|an)\s+([A-Z][\p{L}\p{M}\d'’.-]*)\b/gu;
  while ((match = afterArticle.exec(text)) !== null) {
    if (match[1] !== undefined) add(match[1]);
  }
  return values;
}

function inferAdvantage(
  dice: RollDie[],
  text: string,
  formula: string,
  explicit: unknown,
  explicitUsed: number | null,
  total: number | null,
  modifiers: number,
): { dice: RollDie[]; advantage: AdvantageKind; used: number | null } {
  const d20Indexes = dice
    .map((die, index) => (die.sides === 20 ? index : -1))
    .filter((index) => index >= 0);
  const explicitText = cleanString(explicit)?.toLowerCase() ?? "";
  let advantage: AdvantageKind = /^(?:advantage|adv|high|kh)$/u.test(explicitText)
    ? "advantage"
    : /^(?:disadvantage|disadv|low|kl)$/u.test(explicitText)
      ? "disadvantage"
      : "none";
  const withDropped = d20Indexes.filter((index) => dice[index]?.dropped === true);
  if (d20Indexes.length >= 2 && advantage === "none") {
    if (/disadvantage/iu.test(text)) advantage = "disadvantage";
    else if (/advantage/iu.test(text)) advantage = "advantage";
    else if (/2\s*d\s*20\s*kh/iu.test(formula)) advantage = "advantage";
    else if (/2\s*d\s*20\s*kl/iu.test(formula)) advantage = "disadvantage";
    else if (total !== null) {
      const values = d20Indexes.map((index) => dice[index]?.value ?? 0);
      const usedByTotal = total - modifiers;
      if (values.includes(usedByTotal) && Math.max(...values) !== Math.min(...values)) {
        advantage = usedByTotal === Math.max(...values) ? "advantage" : "disadvantage";
      }
    }
  }
  if (d20Indexes.length >= 2 && withDropped.length === 0 && advantage !== "none") {
    const values = d20Indexes.map((index) => dice[index]?.value ?? 0);
    const usedByTotal = total === null ? null : total - modifiers;
    const chosen =
      usedByTotal !== null && values.includes(usedByTotal)
        ? usedByTotal
        : advantage === "advantage"
          ? Math.max(...values)
          : Math.min(...values);
    for (const index of d20Indexes) {
      if (dice[index] !== undefined)
        dice[index] = { ...dice[index], dropped: dice[index].value !== chosen };
    }
  }
  const kept = d20Indexes
    .map((index) => dice[index])
    .filter((die): die is RollDie => die !== undefined && !die.dropped);
  const used = explicitUsed ?? kept[0]?.value ?? null;
  if (d20Indexes.length >= 2 && advantage === "none" && withDropped.length > 0) {
    advantage = withDropped.some((index) => {
      const value = dice[index]?.value;
      return value !== undefined && value < (kept[0]?.value ?? value);
    })
      ? "advantage"
      : "disadvantage";
  }
  return { dice, advantage, used };
}

function parseRollDetails(message: NormalizedRoll20Message): RollDetails {
  const roll = explicitRollObject(message);
  const template = cleanString(roll["template"]) ?? extractTemplate(message.raw);
  const formula = inputFormula(message, roll) ?? "";
  const sides = formulaSides(formula);
  const inputDice = parseDataDice(
    roll["dice"] ?? (message.source === "json" ? null : undefined),
    sides,
  );
  let dice = inputDice.length > 0 ? inputDice : htmlDice(message.raw, formula);
  if (dice.length === 0) {
    const rollArrays = Array.isArray(roll["rolls"]) ? roll["rolls"] : [];
    const flattened: RollDie[] = [];
    for (const nested of rollArrays) {
      const nestedObject = asRecord(nested);
      if (nestedObject !== null) flattened.push(...parseDataDice(nestedObject["dice"], sides));
    }
    dice = flattened;
  }
  const rawTotal =
    asFiniteNumber(roll["total"] ?? roll["result"]) ??
    asFiniteNumber(
      message.source === "json"
        ? null
        : message.raw.match(
            /(?:data-total|data-result|data-value)\s*=\s*["'](-?\d+(?:\.\d+)?)/iu,
          )?.[1],
    );
  const strongTotal = message.raw.match(/<strong[^>]*>\s*(-?\d+(?:\.\d+)?)\s*<\/strong>/iu)?.[1];
  const titleTotal = message.raw.match(/=\s*(-?\d+(?:\.\d+)?)\s*(?:<|$)/iu)?.[1];
  const explicitModifiers = numberOrSum(roll["modifiers"] ?? roll["modifier"]);
  const modifiers = explicitModifiers ?? modifiersFromFormula(formula);
  const total =
    rawTotal ??
    asFiniteNumber(strongTotal) ??
    asFiniteNumber(titleTotal) ??
    (dice.length === 0
      ? null
      : dice.reduce((sum, die) => sum + (die.dropped ? 0 : die.value), 0) + modifiers);
  const explicitUsed = asFiniteNumber(roll["used_result"] ?? roll["used"]);
  const advantageData = inferAdvantage(
    dice,
    message.text + " " + message.raw,
    formula,
    roll["advantage"],
    explicitUsed,
    total,
    modifiers,
  );
  dice = advantageData.dice;
  const target = targetFromRoll(roll, message.text, message.raw);
  const kind = inferRollKind(
    template,
    message.text + " " + message.raw,
    explicitKind(roll["kind"]),
  );
  return {
    formula,
    dice,
    modifiers,
    total,
    kind,
    advantage: advantageData.advantage,
    used: advantageData.used,
    // Roll-template labels describe mechanics (for example "Longsword
    // Attack"), not necessarily a creature. Templates contribute names only
    // through their explicit target fields; free-form descriptions still use
    // the proper-name extractor below.
    npc_mentions: npcMentions(template === null ? message.text : "", message.who, target),
    template,
    unknown_template: template !== null && !KNOWN_TEMPLATES.has(template),
    target,
  };
}

function parseRollRecord(message: NormalizedRoll20Message, seq: number): RollRecord | OtherRecord {
  const details = parseRollDetails(message);
  const rollInput = explicitRollObject(message);
  const rollId = cleanString(rollInput["id"]) ?? message.id;
  const rollSeq = asInteger(rollInput["seq"]) ?? seq;
  const rollWho = message.who ?? cleanString(rollInput["who"]);
  const rollPlayer = message.player_id ?? cleanString(rollInput["player_id"]);
  const ref = messageRef(message.id, message.source, message.source_index);
  const displayText = rollDisplayText(message, details.template);
  const rawText = details.unknown_template ? message.raw_text : displayText;
  const rollData: RollData = {
    id: rollId,
    seq: rollSeq,
    who: rollWho,
    player_id: rollPlayer,
    formula: details.formula,
    dice: details.dice,
    modifiers: details.modifiers,
    total: details.total,
    kind: details.kind,
    roll_kind: details.kind,
    advantage: details.advantage,
    used: details.used,
    used_result: details.used,
    target: details.target,
    npc_mentions: details.npc_mentions,
    raw_ref: ref,
  };
  const base = {
    id: message.id,
    seq,
    who: rollWho,
    player_id: rollPlayer,
    t_wall_ms: message.t_wall_ms,
    t_mono_ms: message.t_mono_ms,
    text: displayText,
    raw_ref: ref,
    raw_text: rawText,
    raw: message.raw,
    npc_mentions: details.npc_mentions,
  } as const;
  if (details.unknown_template) {
    const record: OtherRecord = {
      ...base,
      kind: "other",
      type: "other",
      roll: rollData,
      ...(details.template === null ? {} : { template: details.template }),
    };
    return record;
  }
  return {
    ...base,
    kind: "roll",
    type: "roll",
    formula: details.formula,
    dice: details.dice,
    modifiers: details.modifiers,
    total: details.total,
    roll_kind: details.kind,
    advantage: details.advantage,
    used: details.used,
    used_result: details.used,
    target: details.target,
    roll: rollData,
  };
}

function rollDisplayText(message: NormalizedRoll20Message, template: string | null): string {
  if (template === null || !KNOWN_TEMPLATES.has(template) || message.raw === "")
    return message.text;
  const elements = scanHtml(message.raw);
  const label = firstTextElement(elements, /(?:^|\s)(?:sheet-label|sheet-header|label)(?:\s|$)/iu);
  const value = label === null ? null : cleanString(textFromHtml(label.inner));
  // The capture and archive paths often disagree about whether numeric die
  // output is included in `text`.  A template label is the stable semantic
  // text, so use a lowercase canonical form when one is available.
  return value === null ? message.text : value.toLowerCase();
}

function baseForMessage(
  message: NormalizedRoll20Message,
  kind: ParsedMessageKind,
  seq: number,
): ParsedMessageBase {
  return {
    kind,
    type: kind,
    id: message.id,
    seq,
    who: message.who,
    player_id: message.player_id,
    t_wall_ms: message.t_wall_ms,
    t_mono_ms: message.t_mono_ms,
    text: message.text,
    raw_ref: messageRef(message.id, message.source, message.source_index),
    raw_text: message.raw_text,
    raw: message.raw,
    npc_mentions: npcMentions(message.text, message.who, null),
  };
}

function parseTurnorderRecord(
  message: NormalizedRoll20Message,
  event: NormalizedTurnorder,
  seq: number,
  previousNonEmpty: boolean,
): TurnorderRecord {
  const marker: TurnorderRecord["marker"] =
    event.entries.length > 0
      ? previousNonEmpty
        ? "changed"
        : "combat_started"
      : previousNonEmpty
        ? "combat_ended"
        : "changed";
  const base = baseForMessage(message, "turnorder", seq);
  return {
    ...base,
    kind: "turnorder",
    type: "turnorder",
    entries: event.entries,
    marker,
  };
}

function parseMessage(
  message: NormalizedRoll20Message,
  fallbackSeq: number,
  previousNonEmpty: boolean,
): ParsedRoll20Message {
  const kind = normalizedKind(message);
  const seq = message.seq ?? fallbackSeq;
  if (kind === "roll") return parseRollRecord(message, seq);
  if (kind === "turnorder" && message.turnorder !== null)
    return parseTurnorderRecord(message, message.turnorder, seq, previousNonEmpty);
  const base = baseForMessage(message, kind, seq);
  if (kind === "whisper") {
    return {
      ...base,
      kind: "whisper",
      type: "whisper",
      to: message.to,
    };
  }
  return { ...base, kind, type: kind } as ParsedRoll20Message;
}

function recordIsTurnorder(record: ParsedRoll20Message): record is TurnorderRecord {
  return record.kind === "turnorder";
}

/** Parse a normalised stream; exported for callers that already normalised input. */
export function parseNormalizedRoll20(input: NormalizedRoll20Input): Roll20ParseResult {
  const parsed: ParsedRoll20Message[] = [];
  const turnorder: TurnorderRecord[] = [];
  const rollRecords: RollRecord[] = [];
  const rollPayloads: RollData[] = [];
  const combatMarkers: CombatMarker[] = [];
  let fallbackSeq = 1;
  let previousNonEmpty = false;
  let unknownCount = 0;
  for (const message of input.messages) {
    const record = parseMessage(message, fallbackSeq, previousNonEmpty);
    fallbackSeq += 1;
    parsed.push(record);
    if (recordIsTurnorder(record)) {
      turnorder.push(record);
      if (record.marker === "combat_started" || record.marker === "combat_ended") {
        combatMarkers.push({
          kind: record.marker,
          seq: record.seq,
          id: record.id,
          raw_ref: record.raw_ref,
        });
      }
      previousNonEmpty = record.entries.length > 0;
    }
    if (record.kind === "roll") {
      rollRecords.push(record);
      rollPayloads.push(record.roll);
    }
    if (record.kind === "other") {
      unknownCount += 1;
      if (record.roll !== undefined) rollPayloads.push(record.roll);
    }
  }
  const qaEntries: Roll20QaEntry[] =
    unknownCount === 0
      ? []
      : [
          {
            code: "ROLL20_UNRECOGNIZED",
            severity: "warning",
            message: `${String(unknownCount)} Roll20 message${unknownCount === 1 ? "" : "s"} could not be classified`,
          },
        ];
  const qa: Roll20QaReport = {
    stage: "roll20",
    entries: qaEntries,
    metrics: {
      unrecognized_messages: unknownCount,
      unknown_messages: unknownCount,
      other_messages: unknownCount,
      parsed_messages: parsed.length,
      roll_count: rollPayloads.length,
      turnorder_count: turnorder.length,
    },
    unrecognized_count: unknownCount,
    unknown_count: unknownCount,
    other_count: unknownCount,
    unrecognized: unknownCount,
    unknown: unknownCount,
  };
  return {
    normalized: input,
    messages: parsed,
    records: parsed,
    rolls: rollPayloads,
    roll_records: rollRecords,
    turnorder,
    turnorder_events: turnorder,
    combat_markers: combatMarkers,
    qa,
    unrecognized_count: unknownCount,
    unknown_count: unknownCount,
    unrecognized: unknownCount,
  };
}

/** Parse either P1-04 JSON or a saved chat archive HTML page. */
export function parseRoll20(input: unknown): Roll20ParseResult {
  return parseNormalizedRoll20(normalizeRoll20Input(input));
}

/** Explicit aliases make the input shape clear at call sites. */
export const parseRoll20Capture = parseRoll20;
export const parseRoll20Archive = parseRoll20;
export const parseRoll20Html = parseRoll20;
export const parseRoll20Json = parseRoll20;
export const parseRoll20CaptureJson = parseRoll20;
export const normaliseRoll20Input = normalizeRoll20Input;
