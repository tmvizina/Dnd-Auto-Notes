/* global window */
/* eslint-disable @typescript-eslint/no-unused-vars */

(function installDndCapture(root) {
  "use strict";

  // This is intentionally a single, ordinary browser script.  Roll20 changes its
  // markup often, so the recording is useful even when one of the parsers needs
  // to be taught about a new class name later.
  if (!root || !root.document) {
    return;
  }

  if (root.dndCapture && root.dndCapture.__dndCapture === true) {
    return;
  }

  var document = root.document;
  var VERSION = 1;
  var STORAGE_PREFIX = "dndCapture:roll20:";
  var STORAGE_LIMIT_BYTES = 4 * 1024 * 1024;
  var STORAGE_WARN_BYTES = Math.floor(STORAGE_LIMIT_BYTES * 0.8);
  var MAX_MESSAGES = 10000;
  var MAX_TURNORDER_EVENTS = 5000;

  var active = false;
  var observedChat = null;
  var observedTurnorder = null;
  var observedRoot = null;
  var chatObserver = null;
  var turnorderObserver = null;
  var rootObserver = null;
  var warned = {};
  var storage = null;
  var storageKey = "";
  var storageBytes = 0;
  var storagePersisted = false;
  var lastTurnSignature = null;
  var turnorderAttached = false;
  var nextMessageSeq = 1;
  var nextTurnorderSeq = 1;
  var weakMapConstructor;
  var messageNodeKeys = null;
  var messageRecordKeys = null;
  var messageNodeKeyEntries = [];
  var messageRecordKeyEntries = [];
  var nextAnonymousMessageKey = 1;

  try {
    weakMapConstructor = root.WeakMap || (typeof WeakMap === "function" ? WeakMap : null);
    if (weakMapConstructor) {
      messageNodeKeys = new weakMapConstructor();
      messageRecordKeys = new weakMapConstructor();
    }
  } catch (_error) {
    // The small array fallback below keeps old/embedded browsers usable.
  }

  function safeLog(level, message, value) {
    try {
      var consoleObject = root.console;
      if (!consoleObject || typeof consoleObject[level] !== "function") {
        return;
      }
      if (typeof value === "undefined") {
        consoleObject[level]("[dndCapture] " + message);
      } else {
        consoleObject[level]("[dndCapture] " + message, value);
      }
    } catch (_error) {
      // A page can replace console methods.  Capture must never report an error
      // back into the Roll20 page because of a diagnostic message.
    }
  }

  function warnOnce(code, message, value) {
    if (warned[code]) {
      return;
    }
    warned[code] = true;
    safeLog("warn", message, value);
  }

  function safeDateNow() {
    try {
      return Date.now();
    } catch (_error) {
      return null;
    }
  }

  function safePerformanceNow() {
    try {
      if (root.performance && typeof root.performance.now === "function") {
        return root.performance.now();
      }
    } catch (_error) {
      // Fall through to the explicit null below.
    }
    warnOnce("no-performance", "performance.now() is unavailable; monotonic timestamps are null.");
    return null;
  }

  function isoFromWall(wall) {
    try {
      if (typeof wall === "number" && isFinite(wall)) {
        return new Date(wall).toISOString();
      }
    } catch (_error) {
      // Keep the nullable timestamp rather than throwing from a capture path.
    }
    return null;
  }

  function byteLength(value) {
    try {
      if (typeof TextEncoder === "function") {
        return new TextEncoder().encode(value).length;
      }
    } catch (_error) {
      // String length is a conservative enough fallback for old browsers.
    }
    return String(value).length;
  }

  function safeGetStorage() {
    try {
      if (root.localStorage && typeof root.localStorage.getItem === "function") {
        return root.localStorage;
      }
    } catch (_error) {
      warnOnce(
        "storage-unavailable",
        "localStorage is unavailable; this capture remains in memory only.",
      );
    }
    return null;
  }

  function safeStorageGet(key) {
    if (!storage) {
      return null;
    }
    try {
      return storage.getItem(key);
    } catch (_error) {
      warnOnce("storage-read", "Could not read the saved capture from localStorage.");
      return null;
    }
  }

  function safeStorageSet(key, value) {
    if (!storage) {
      return false;
    }
    try {
      storage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function safeStorageRemove(key) {
    if (!storage) {
      return;
    }
    try {
      storage.removeItem(key);
    } catch (_error) {
      // A denied remove should not make clear() throw into the page.
    }
  }

  function safeQueryOne(parent, selector) {
    try {
      if (parent && typeof parent.querySelector === "function") {
        return parent.querySelector(selector);
      }
    } catch (_error) {
      // Roll20 extensions can replace DOM methods.  Treat a bad selector as no match.
    }
    return null;
  }

  function safeQueryAll(parent, selector) {
    try {
      if (parent && typeof parent.querySelectorAll === "function") {
        return parent.querySelectorAll(selector);
      }
    } catch (_error) {
      // See safeQueryOne().
    }
    return [];
  }

  function safeAttribute(element, name) {
    try {
      if (element && typeof element.getAttribute === "function") {
        var value = element.getAttribute(name);
        return value === null || typeof value === "undefined" ? null : String(value);
      }
    } catch (_error) {
      // An inaccessible node is simply not attributed.
    }
    return null;
  }

  function firstAttribute(element, names) {
    var i;
    for (i = 0; i < names.length; i += 1) {
      var value = safeAttribute(element, names[i]);
      if (value !== null && value !== "") {
        return value;
      }
    }
    return null;
  }

  function safeText(element) {
    try {
      return element && element.textContent ? String(element.textContent) : "";
    } catch (_error) {
      return "";
    }
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function classText(element) {
    try {
      if (!element) {
        return "";
      }
      if (typeof element.className === "string") {
        return element.className;
      }
      if (element.className && typeof element.className.baseVal === "string") {
        return element.className.baseVal;
      }
    } catch (_error) {
      // No class information is fine; data attributes still provide a parser hint.
    }
    return "";
  }

  function hasClassHint(element, expression) {
    return expression.test(classText(element).toLowerCase());
  }

  function outerHTML(element) {
    try {
      return element && typeof element.outerHTML === "string" ? element.outerHTML : "";
    } catch (_error) {
      return "";
    }
  }

  function isElement(node) {
    return !!node && (node.nodeType === 1 || typeof node.querySelectorAll === "function");
  }

  function isConnected(node) {
    try {
      if (typeof node.isConnected === "boolean") {
        return node.isConnected;
      }
      return !!(document.documentElement && document.documentElement.contains(node));
    } catch (_error) {
      return true;
    }
  }

  function elementMessageCandidate(element) {
    if (!isElement(element)) {
      return false;
    }
    return (
      safeAttribute(element, "data-messageid") !== null ||
      safeAttribute(element, "data-message-id") !== null ||
      /(^|\s)message(?:\s|$)/i.test(classText(element))
    );
  }

  function addUnique(list, seen, element) {
    if (!element || !isElement(element) || seen.indexOf(element) !== -1) {
      return;
    }
    seen.push(element);
    list.push(element);
  }

  function compareDomOrder(left, right) {
    try {
      if (left === right) {
        return 0;
      }
      if (typeof left.compareDocumentPosition === "function") {
        var position = left.compareDocumentPosition(right);
        if (position & 2) {
          return 1;
        }
        if (position & 4) {
          return -1;
        }
      }
    } catch (_error) {
      // NodeList order is already document order in real browsers.
    }
    return 0;
  }

  function messageElements(container) {
    var result = [];
    var seen = [];
    if (elementMessageCandidate(container)) {
      addUnique(result, seen, container);
    }
    var candidates = safeQueryAll(container, ".message, [data-messageid], [data-message-id]");
    var i;
    for (i = 0; i < candidates.length; i += 1) {
      if (elementMessageCandidate(candidates[i])) {
        addUnique(result, seen, candidates[i]);
      }
    }
    try {
      result.sort(compareDomOrder);
    } catch (_error) {
      // Keep the query's native order if a hostile page prevents sorting.
    }
    return result;
  }

  function messageElementsFromNode(node) {
    var result = [];
    var seen = [];
    if (elementMessageCandidate(node)) {
      addUnique(result, seen, node);
    }
    var candidates = safeQueryAll(node, ".message, [data-messageid], [data-message-id]");
    var i;
    for (i = 0; i < candidates.length; i += 1) {
      if (elementMessageCandidate(candidates[i])) {
        addUnique(result, seen, candidates[i]);
      }
    }
    try {
      result.sort(compareDomOrder);
    } catch (_error) {
      // Keep the query's native order.
    }
    return result;
  }

  function closestMessage(node) {
    var current = node;
    while (current) {
      if (elementMessageCandidate(current)) {
        return current;
      }
      try {
        current = current.parentElement || current.parentNode;
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function findChatContainer() {
    var selectors = ["#textchat", "[data-testid='textchat']", "[data-testid*='chat']", ".textchat"];
    var i;
    for (i = 0; i < selectors.length; i += 1) {
      var match = safeQueryOne(document, selectors[i]);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function findTurnorderContainer() {
    var selectors = [
      "#turnorder",
      "#turnorderlist",
      "[data-testid='turn-order']",
      "[data-testid*='turnorder']",
      ".turnorder",
      ".turn-order",
    ];
    var i;
    for (i = 0; i < selectors.length; i += 1) {
      var match = safeQueryOne(document, selectors[i]);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function gameIdFromLocation() {
    try {
      var location = root.location;
      if (!location) {
        return "unknown";
      }
      var search = String(location.search || "");
      var queryMatch = search.match(/[?&](?:campaignid|gameid|game_id|id)=([^&]+)/i);
      if (queryMatch && queryMatch[1]) {
        return decodeURIComponent(queryMatch[1]);
      }
      var path = String(location.pathname || "");
      var pathMatch =
        path.match(/\/campaigns\/(?:details\/)?([^/?#]+)/i) ||
        path.match(/\/games?\/([^/?#]+)/i) ||
        path.match(/\/editor\/(?:set|setup|setups)\/([^/?#]+)/i) ||
        path.match(/\/editor\/([^/?#]+)/i);
      if (pathMatch && pathMatch[1]) {
        return decodeURIComponent(pathMatch[1]);
      }
      var numeric = path.match(/\b(\d{4,})\b/);
      if (numeric && numeric[1]) {
        return numeric[1];
      }
      if (path) {
        return path.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "unknown";
      }
    } catch (_error) {
      // A browser privacy wrapper may deny location access.
    }
    return "unknown";
  }

  function sessionKeyForGame(gameId) {
    var safeGameId = String(gameId || "unknown");
    try {
      safeGameId = encodeURIComponent(safeGameId);
    } catch (_error) {
      safeGameId = "unknown";
    }
    return STORAGE_PREFIX + safeGameId;
  }

  function freshState(gameId) {
    return {
      version: VERSION,
      captured_at: null,
      mode: "post-hoc",
      game_id: gameId,
      messages: [],
      turnorder_events: [],
    };
  }

  function validArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function numberOrNull(value) {
    if (typeof value === "number" && isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      var parsed = Number(value);
      if (isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  function normaliseDice(dice) {
    var result = [];
    var source = validArray(dice);
    var i;
    for (i = 0; i < source.length; i += 1) {
      var item = source[i];
      if (typeof item === "number" || typeof item === "string") {
        var value = numberOrNull(item);
        if (value !== null) {
          result.push({ sides: null, value: value, dropped: false });
        }
      } else if (item && typeof item === "object") {
        var itemValue = numberOrNull(item.value);
        if (itemValue === null) {
          itemValue = numberOrNull(item.v);
        }
        if (itemValue !== null) {
          result.push({
            sides: numberOrNull(item.sides),
            value: itemValue,
            dropped: item.dropped === true || item.dropped === "true" || item.drop === true,
          });
        }
      }
    }
    return result;
  }

  function parseJson(value) {
    try {
      var trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed && (trimmed.charAt(0) === "[" || trimmed.charAt(0) === "{")) {
        return JSON.parse(value);
      }
    } catch (_error) {
      // Roll20 sometimes stores a JavaScript-ish value instead of JSON.
    }
    return null;
  }

  function collectDiceFromValue(value, output) {
    if (!value || output.length > 100) {
      return;
    }
    if (Array.isArray(value)) {
      var i;
      for (i = 0; i < value.length; i += 1) {
        collectDiceFromValue(value[i], output);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    var direct = normaliseDice([value]);
    if (direct.length) {
      output.push(direct[0]);
      return;
    }
    var keys = Object.keys(value);
    var j;
    for (j = 0; j < keys.length; j += 1) {
      collectDiceFromValue(value[keys[j]], output);
    }
  }

  function parseNumericList(value) {
    var result = [];
    var matches = String(value || "").match(/-?\d+(?:\.\d+)?/g) || [];
    var i;
    for (i = 0; i < matches.length; i += 1) {
      var parsed = numberOrNull(matches[i]);
      if (parsed !== null) {
        result.push(parsed);
      }
    }
    return result;
  }

  function diceSides(formula) {
    var result = [];
    var match;
    var expression = /(?:^|[^\w])(\d+)\s*d\s*(\d+)(?=$|[^\w])/gi;
    var text = String(formula || "");
    while ((match = expression.exec(text)) !== null) {
      var count = Number(match[1]);
      var sides = Number(match[2]);
      if (!isFinite(count) || count < 1 || count > 100 || !isFinite(sides)) {
        continue;
      }
      var i;
      for (i = 0; i < count; i += 1) {
        result.push(sides);
      }
    }
    return result;
  }

  function rollFormulaFromTitle(title) {
    var value = String(title || "").trim();
    if (!value) {
      return null;
    }
    var rolling = value.match(/^rolling\s+(.+?)(?:\s*=\s*|$)/i);
    if (rolling && rolling[1]) {
      return rolling[1].trim();
    }
    var beforeEquals = value.split("=")[0].trim();
    return beforeEquals || null;
  }

  function rollTotalFromTitle(title) {
    var value = String(title || "");
    var matches = value.match(/=\s*(-?\d+(?:\.\d+)?)\s*(?:$|<)/g);
    if (matches && matches.length) {
      return numberOrNull(matches[matches.length - 1].replace(/^[^\d-]*/, ""));
    }
    var numbers = parseNumericList(value);
    return numbers.length ? numbers[numbers.length - 1] : null;
  }

  function rollDiceFromTitle(title) {
    var result = [];
    var groups = String(title || "").match(/\(([-+\d.,\s]+)\)/g) || [];
    var i;
    for (i = 0; i < groups.length; i += 1) {
      var values = parseNumericList(groups[i]);
      var j;
      for (j = 0; j < values.length; j += 1) {
        result.push(values[j]);
      }
    }
    return result;
  }

  function rollSourceElements(messageElement) {
    var result = [];
    var seen = [];
    var selectors = [
      ".inlinerollresult",
      ".basicdiceroll",
      ".diceroll",
      ".die",
      "[data-formula]",
      "[data-rollformula]",
      "[data-roll]",
      "[data-die]",
    ];
    var i;
    for (i = 0; i < selectors.length; i += 1) {
      var nodes = safeQueryAll(messageElement, selectors[i]);
      var j;
      for (j = 0; j < nodes.length; j += 1) {
        if (seen.indexOf(nodes[j]) === -1) {
          seen.push(nodes[j]);
          result.push(nodes[j]);
        }
      }
    }
    if (
      result.length === 0 &&
      hasClassHint(messageElement, /(?:rollresult|inlinerollresult|rolltemplate)/i)
    ) {
      result.unshift(messageElement);
    }
    return result;
  }

  function parseRollSource(source) {
    var title = firstAttribute(source, ["title", "data-title", "aria-label"]);
    var formula = firstAttribute(source, ["data-formula", "data-rollformula", "data-expression"]);
    var dataRoll = firstAttribute(source, ["data-roll", "data-dice"]);
    var raw = outerHTML(source);
    var formulaMatches = raw.match(/\[\[\s*([\s\S]*?)\s*\]\]/g) || [];
    if (!formula && formulaMatches.length) {
      formula = formulaMatches[0].replace(/^\[\[\s*|\s*\]\]$/g, "").trim();
    }
    if (!formula && title) {
      formula = rollFormulaFromTitle(title);
    }
    if (!formula) {
      var slashRoll = (safeText(source) + " " + raw).match(/(?:\/r|\/roll)\s+([^\n<]+)/i);
      if (slashRoll && slashRoll[1]) {
        formula = slashRoll[1].replace(/\s*=.*$/, "").trim();
      }
    }

    var dice = [];
    var parsedData = parseJson(dataRoll);
    if (parsedData !== null) {
      collectDiceFromValue(parsedData, dice);
    }
    var titleDice = rollDiceFromTitle(title);
    var sides = diceSides(formula);
    var i;
    for (i = 0; i < titleDice.length; i += 1) {
      dice.push({
        sides: sides[i] === undefined ? null : sides[i],
        value: titleDice[i],
        dropped: /(?:dropped|discarded|drop)/i.test(title || ""),
      });
    }

    var dieNodes = safeQueryAll(source, ".basicdiceroll, .diceroll, .die, [data-die]");
    if (
      hasClassHint(source, /(?:^|\s)(?:basicdiceroll|diceroll|die)(?:\s|$)/i) ||
      firstAttribute(source, ["data-die"])
    ) {
      dieNodes.unshift(source);
    }
    for (i = 0; i < dieNodes.length; i += 1) {
      var didRoll = safeQueryOne(dieNodes[i], ".didroll");
      var dieValue = numberOrNull(
        firstAttribute(dieNodes[i], ["data-die", "data-value", "data-result"]),
      );
      if (dieValue === null) {
        dieValue = numberOrNull(cleanText(safeText(didRoll || dieNodes[i])));
      }
      if (dieValue !== null) {
        var classSides = (classText(dieNodes[i]).match(/(?:^|\s)d(\d+)(?:\s|$)/i) || [])[1];
        dice.push({
          sides:
            numberOrNull(firstAttribute(dieNodes[i], ["data-sides", "data-size"])) ||
            numberOrNull(classSides) ||
            (sides[dice.length] === undefined ? null : sides[dice.length]),
          value: dieValue,
          dropped: /(?:dropped|discarded|drop)/i.test(
            classText(dieNodes[i]) + " " + (firstAttribute(dieNodes[i], ["data-dropped"]) || ""),
          ),
        });
      }
    }

    var total = numberOrNull(firstAttribute(source, ["data-total", "data-result", "data-value"]));
    if (total === null && title) {
      total = rollTotalFromTitle(title);
    }
    if (total === null) {
      total = numberOrNull(cleanText(safeText(source)));
    }
    if (total === null && dice.length) {
      total = dice.reduce(function sum(values, die) {
        return values + (die.dropped ? 0 : die.value);
      }, 0);
    }

    for (i = 0; i < dice.length; i += 1) {
      if (dice[i].sides === null && sides[i] !== undefined) {
        dice[i].sides = sides[i];
      }
    }
    return {
      formula: formula ? String(formula).trim() : null,
      dice: dice,
      total: total,
    };
  }

  function parseRoll(messageElement, kind, text, raw) {
    var sources = rollSourceElements(messageElement);
    var hasRollMarkup =
      kind === "rollresult" ||
      sources.length > 0 ||
      /\[\[[\s\S]*?\]\]|sheet-rolltemplate-|(?:\/r|\/roll)\s+/i.test(raw + " " + text);
    if (!hasRollMarkup) {
      return null;
    }
    if (!sources.length) {
      sources = [messageElement];
    }
    var rolls = [];
    var formulaParts = [];
    var dice = [];
    var total = null;
    var i;
    var formulaNodes = safeQueryAll(messageElement, ".formula");
    for (i = 0; i < formulaNodes.length; i += 1) {
      var formulaText = cleanText(safeText(formulaNodes[i]));
      var nestedRolls = safeQueryAll(
        formulaNodes[i],
        ".inlinerollresult, .basicdiceroll, .diceroll, .die, [data-die]",
      );
      var nestedIndex;
      for (nestedIndex = 0; nestedIndex < nestedRolls.length; nestedIndex += 1) {
        var nestedText = cleanText(safeText(nestedRolls[nestedIndex]));
        if (nestedText) {
          formulaText = formulaText.replace(nestedText, "");
        }
      }
      formulaText = formulaText.replace(/\s*=\s*-?\d+(?:\.\d+)?\s*$/, "").trim();
      if (formulaText && formulaParts.indexOf(formulaText) === -1) {
        formulaParts.push(formulaText);
      }
    }
    for (i = 0; i < sources.length; i += 1) {
      var parsed = parseRollSource(sources[i]);
      if (
        formulaParts.length &&
        hasClassHint(sources[i], /(?:^|\s)(?:basicdiceroll|diceroll)(?:\s|$)/i) &&
        safeQueryOne(sources[i], ".didroll")
      ) {
        parsed.formula = null;
      }
      if (parsed.formula && formulaParts.indexOf(parsed.formula) === -1) {
        formulaParts.push(parsed.formula);
      }
      if (parsed.dice.length) {
        dice = dice.concat(parsed.dice);
      }
      if (parsed.total !== null) {
        total = parsed.total;
      }
      if (parsed.formula || parsed.dice.length || parsed.total !== null) {
        rolls.push(parsed);
      }
    }

    if (!formulaParts.length) {
      var fallbackFormula = (raw.match(/\[\[\s*([\s\S]*?)\s*\]\]/) || [])[1];
      if (fallbackFormula) {
        formulaParts.push(fallbackFormula.trim());
      }
    }
    if (total === null) {
      var textNumbers = parseNumericList(text);
      if (textNumbers.length && (formulaParts.length || kind === "rollresult")) {
        total = textNumbers[textNumbers.length - 1];
      }
    }
    return {
      formula: formulaParts.length ? formulaParts.join(" | ") : null,
      dice: dice,
      total: total,
      rolls: rolls,
    };
  }

  function messageKind(element, raw) {
    var classes = classText(element).toLowerCase();
    var dataKind = firstAttribute(element, ["data-kind", "data-type", "data-message-type"]);
    var hint = (classes + " " + String(dataKind || "")).toLowerCase();
    if (/(?:rollresult|rolltemplate|inlinerollresult)/i.test(hint)) {
      return "rollresult";
    }
    if (/(?:sheet-rolltemplate-|inlinerollresult|\[\[[\s\S]*?\]\]|(?:\/r|\/roll)\s+)/i.test(raw)) {
      return "rollresult";
    }
    if (/(?:^|[\s._-])whisper(?:$|[\s._-])/.test(hint)) {
      return "whisper";
    }
    if (/(?:^|[\s._-])emote(?:$|[\s._-])/.test(hint)) {
      return "emote";
    }
    if (/(?:^|[\s._-])(?:desc|description)(?:$|[\s._-])/.test(hint)) {
      return "desc";
    }
    if (/(?:^|[\s._-])(?:system|error|announce|api)(?:$|[\s._-])/.test(hint)) {
      return "system";
    }
    return "general";
  }

  function playerId(element) {
    var own = firstAttribute(element, [
      "data-playerid",
      "data-player-id",
      "data-player_id",
      "data-player",
    ]);
    if (own) {
      return own;
    }
    var node = safeQueryOne(
      element,
      "[data-playerid], [data-player-id], [data-player_id], [data-player]",
    );
    return firstAttribute(node, [
      "data-playerid",
      "data-player-id",
      "data-player_id",
      "data-player",
    ]);
  }

  function messageId(element) {
    return firstAttribute(element, ["data-messageid", "data-message-id"]);
  }

  function messageWho(element) {
    var speaker = safeQueryOne(element, ".by, .speaker, [data-who], [data-speaker]");
    var value = firstAttribute(speaker, ["data-who", "data-speaker"]);
    return cleanText(value || safeText(speaker));
  }

  function messageText(element, who) {
    var content = safeQueryOne(element, ".messagecontent, .message-content, .content, .msg");
    var text = cleanText(safeText(content || element));
    // If a minimal/future DOM has no content wrapper, avoid duplicating the
    // speaker label in the message text while retaining the actual text.
    if (!content && who && text.indexOf(who) === 0) {
      text = cleanText(text.slice(who.length));
    }
    return text;
  }

  function timingFromElement(element) {
    var value = firstAttribute(element, [
      "data-timestamp",
      "data-time",
      "data-wall-ms",
      "data-wallclock",
      "timestamp",
    ]);
    var wall = numberOrNull(value);
    return { wall: wall, mono: null };
  }

  function sideTableGet(map, entries, object) {
    if (!object) {
      return null;
    }
    if (map) {
      try {
        return map.get(object) || null;
      } catch (_error) {
        // Fall through to the small identity table.
      }
    }
    var i;
    for (i = 0; i < entries.length; i += 1) {
      if (entries[i].object === object) {
        return entries[i].key;
      }
    }
    return null;
  }

  function sideTableSet(map, entries, object, key) {
    if (!object) {
      return;
    }
    if (map) {
      try {
        map.set(object, key);
        return;
      } catch (_error) {
        // Fall through to the small identity table.
      }
    }
    var i;
    for (i = 0; i < entries.length; i += 1) {
      if (entries[i].object === object) {
        entries[i].key = key;
        return;
      }
    }
    entries.push({ object: object, key: key });
  }

  function nodeMessageKey(element) {
    var existing = sideTableGet(messageNodeKeys, messageNodeKeyEntries, element);
    if (existing) {
      return existing;
    }
    var key = "node:" + String(nextAnonymousMessageKey);
    nextAnonymousMessageKey += 1;
    sideTableSet(messageNodeKeys, messageNodeKeyEntries, element, key);
    return key;
  }

  function recordMessageKey(message) {
    return sideTableGet(messageRecordKeys, messageRecordKeyEntries, message);
  }

  function setRecordMessageKey(message, key) {
    sideTableSet(messageRecordKeys, messageRecordKeyEntries, message, key);
  }

  function messageFingerprint(message) {
    var input = String(message.outerHTML || "") + "\u0000" + message.text + "\u0000" + message.who;
    var hash = 2166136261;
    var i;
    for (i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return "fingerprint:" + (hash >>> 0).toString(16);
  }

  function messageKey(message, element) {
    if (message.id) {
      return "id:" + message.id;
    }
    var existing = recordMessageKey(message);
    if (existing) {
      return existing;
    }
    if (element) {
      return nodeMessageKey(element);
    }
    return messageFingerprint(message);
  }

  function messageRecord(element, timing) {
    var raw = outerHTML(element);
    var id = messageId(element);
    var who = messageWho(element);
    var kind = messageKind(element, raw);
    var text = messageText(element, who);
    var record = {
      seq: null,
      id: id,
      who: who || null,
      player_id: playerId(element),
      kind: kind,
      text: text,
      t_wall_ms: timing && timing.wall !== null ? timing.wall : null,
      t_mono_ms: timing && timing.mono !== null ? timing.mono : null,
      outerHTML: raw,
    };
    var roll = parseRoll(element, kind, text, raw);
    if (roll) {
      record.formula = roll.formula;
      record.dice = roll.dice;
      record.total = roll.total;
      record.rolls = roll.rolls;
    }
    return record;
  }

  function ensureCapturedAt(wall) {
    if (!state.captured_at) {
      state.captured_at = isoFromWall(wall) || isoFromWall(safeDateNow());
    }
  }

  function capInMemory() {
    while (state.messages.length > MAX_MESSAGES) {
      state.messages.shift();
      warnOnce(
        "message-cap",
        "The in-memory message cap was reached; oldest messages are being dropped.",
      );
    }
    while (state.turnorder_events.length > MAX_TURNORDER_EVENTS) {
      state.turnorder_events.shift();
      warnOnce(
        "turnorder-cap",
        "The in-memory turn-order cap was reached; oldest events are being dropped.",
      );
    }
  }

  function serialisableState() {
    return {
      version: VERSION,
      captured_at: state.captured_at,
      mode: state.mode,
      game_id: state.game_id,
      messages: state.messages,
      turnorder_events: state.turnorder_events,
    };
  }

  function persist() {
    capInMemory();
    if (!storage) {
      storagePersisted = false;
      return;
    }
    var payload;
    var json;
    try {
      payload = serialisableState();
      json = JSON.stringify(payload);
    } catch (_error) {
      warnOnce(
        "storage-serialise",
        "Could not serialise the capture for localStorage; it remains in memory.",
      );
      storagePersisted = false;
      return;
    }

    storageBytes = byteLength(json);
    if (storageBytes >= STORAGE_WARN_BYTES) {
      warnOnce(
        "storage-near-quota",
        "Capture storage is near its safety cap; save soon and clear when the session is over.",
        {
          bytes: storageBytes,
          cap_bytes: STORAGE_LIMIT_BYTES,
        },
      );
    }

    // Drop oldest records only as a last resort.  The raw markup stays intact
    // on every record that remains, which is the replayability guarantee.
    while (
      storageBytes > STORAGE_LIMIT_BYTES &&
      (state.messages.length || state.turnorder_events.length)
    ) {
      if (
        state.messages.length &&
        (!state.turnorder_events.length || state.messages.length >= state.turnorder_events.length)
      ) {
        state.messages.shift();
      } else {
        state.turnorder_events.shift();
      }
      warnOnce(
        "storage-cap",
        "Capture storage reached its safety cap; oldest records are being dropped.",
      );
      try {
        json = JSON.stringify(serialisableState());
        storageBytes = byteLength(json);
      } catch (_error) {
        storagePersisted = false;
        return;
      }
    }

    if (storageBytes > STORAGE_LIMIT_BYTES) {
      warnOnce(
        "record-too-large",
        "A capture record is too large for the localStorage safety cap; it remains in memory only.",
      );
      storagePersisted = false;
      return;
    }
    storagePersisted = safeStorageSet(storageKey, json);
    if (!storagePersisted) {
      warnOnce(
        "storage-write",
        "Could not write the capture to localStorage; it remains in memory only.",
      );
    }
  }

  function restore() {
    var encoded = safeStorageGet(storageKey);
    if (!encoded) {
      return freshState(gameId);
    }
    storageBytes = byteLength(encoded);
    storagePersisted = true;
    try {
      var saved = JSON.parse(encoded);
      if (!saved || typeof saved !== "object") {
        return freshState(gameId);
      }
      var restored = freshState(saved.game_id || gameId);
      restored.captured_at = typeof saved.captured_at === "string" ? saved.captured_at : null;
      restored.mode = saved.mode === "live" ? "live" : "post-hoc";
      restored.messages = validArray(saved.messages).filter(function keepMessage(item) {
        return item && typeof item === "object" && typeof item.outerHTML === "string";
      });
      restored.turnorder_events = validArray(saved.turnorder_events).filter(
        function keepEvent(item) {
          return item && typeof item === "object" && Array.isArray(item.entries);
        },
      );
      nextMessageSeq = restored.messages.reduce(function maxMessage(value, item) {
        var seq = numberOrNull(item.seq);
        return seq !== null && seq >= value ? seq + 1 : value;
      }, 1);
      nextTurnorderSeq = restored.turnorder_events.reduce(function maxEvent(value, item) {
        var seq = numberOrNull(item.seq);
        return seq !== null && seq >= value ? seq + 1 : value;
      }, 1);
      if (restored.turnorder_events.length) {
        lastTurnSignature = turnSignature(
          restored.turnorder_events[restored.turnorder_events.length - 1].entries,
        );
      }
      capInMemoryFor(restored);
      return restored;
    } catch (_error) {
      warnOnce(
        "storage-invalid",
        "The saved capture was not valid JSON; starting with an empty in-memory buffer.",
      );
      return freshState(gameId);
    }
  }

  function capInMemoryFor(value) {
    while (value.messages.length > MAX_MESSAGES) {
      value.messages.shift();
    }
    while (value.turnorder_events.length > MAX_TURNORDER_EVENTS) {
      value.turnorder_events.shift();
    }
  }

  function upsertMessage(element, timing, fallbackUsed, reconcileExisting) {
    if (!elementMessageCandidate(element)) {
      return false;
    }
    var parsed;
    try {
      parsed = messageRecord(element, timing);
    } catch (_error) {
      warnOnce("message-parse", "A chat message could not be read; its DOM node was skipped.");
      return false;
    }
    var key = messageKey(parsed, element);
    var index = -1;
    var i;
    for (i = 0; i < state.messages.length; i += 1) {
      if (messageKey(state.messages[i]) === key) {
        index = i;
        break;
      }
    }
    if (index < 0 && !parsed.id) {
      var fingerprint = messageFingerprint(parsed);
      for (i = 0; i < state.messages.length; i += 1) {
        var candidate = state.messages[i];
        if (
          !candidate.id &&
          (!recordMessageKey(candidate) || reconcileExisting) &&
          fallbackUsed.indexOf(i) === -1 &&
          messageFingerprint(candidate) === fingerprint
        ) {
          index = i;
          fallbackUsed.push(i);
          setRecordMessageKey(candidate, key);
          break;
        }
      }
    }
    if (index >= 0) {
      var previous = state.messages[index];
      parsed.seq = previous.seq;
      // A rerender can supply a fresh timestamp while it updates the same
      // message.  The first observation is the event time we want to retain.
      parsed.t_wall_ms = previous.t_wall_ms === undefined ? null : previous.t_wall_ms;
      parsed.t_mono_ms = previous.t_mono_ms === undefined ? null : previous.t_mono_ms;
      setRecordMessageKey(parsed, key);
      state.messages[index] = parsed;
      return true;
    }
    parsed.seq = nextMessageSeq;
    nextMessageSeq += 1;
    setRecordMessageKey(parsed, key);
    state.messages.push(parsed);
    ensureCapturedAt(parsed.t_wall_ms);
    capInMemory();
    return true;
  }

  function captureMessages(elements, live, reconcileExisting) {
    var changed = false;
    var fallbackUsed = [];
    var i;
    for (i = 0; i < elements.length; i += 1) {
      var timing = live
        ? { wall: safeDateNow(), mono: safePerformanceNow() }
        : timingFromElement(elements[i]);
      if (upsertMessage(elements[i], timing, fallbackUsed, Boolean(reconcileExisting))) {
        changed = true;
      }
    }
    if (changed) {
      persist();
    }
    return changed;
  }

  function turnEntries(container) {
    var candidates = [];
    var seen = [];
    var selectors = [
      "li",
      ".turnorderitem",
      ".turnorder-item",
      "[data-tokid]",
      "[data-tokenid]",
      "[data-token-id]",
    ];
    var i;
    for (i = 0; i < selectors.length; i += 1) {
      var nodes = safeQueryAll(container, selectors[i]);
      var j;
      for (j = 0; j < nodes.length; j += 1) {
        if (seen.indexOf(nodes[j]) === -1) {
          seen.push(nodes[j]);
          candidates.push(nodes[j]);
        }
      }
    }
    if (!candidates.length) {
      var encoded = firstAttribute(container, ["data-turnorder", "data-order"]);
      var parsed = parseJson(encoded);
      if (Array.isArray(parsed)) {
        return parsed.map(function mapEntry(item) {
          return {
            name: cleanText(item && (item.name || item.n || "")) || null,
            value: numberOrNull(item && (item.value === undefined ? item.pr : item.value)),
            token_id:
              item && (item.token_id || item.id || item.tokid)
                ? String(item.token_id || item.id || item.tokid)
                : null,
          };
        });
      }
      return [];
    }
    return candidates.map(function mapCandidate(item) {
      var nameNode = safeQueryOne(item, ".name, .token-name, .turnorder-name, [data-name]");
      var valueNode = safeQueryOne(
        item,
        ".pr, .initiative, .turnorder-value, .turnorder-pr, [data-value]",
      );
      var tokenId = firstAttribute(item, [
        "data-tokid",
        "data-tokenid",
        "data-token-id",
        "data-id",
      ]);
      var name = firstAttribute(nameNode, ["data-name"]) || cleanText(safeText(nameNode));
      var value =
        numberOrNull(firstAttribute(valueNode, ["data-value", "data-pr"])) ||
        numberOrNull(cleanText(safeText(valueNode)));
      if (!name && !valueNode) {
        var fallback = cleanText(safeText(item));
        var number = fallback.match(/-?\d+(?:\.\d+)?/);
        value = numberOrNull(number && number[0]);
        name = number ? cleanText(fallback.replace(number[0], "")) : fallback;
      }
      return {
        name: name || null,
        value: value,
        token_id: tokenId || null,
      };
    });
  }

  function turnSignature(entries) {
    try {
      return JSON.stringify(entries);
    } catch (_error) {
      return String(entries.length);
    }
  }

  function captureTurnorder(container, force, nonEmptyOnly) {
    if (!container) {
      return false;
    }
    var entries;
    try {
      entries = turnEntries(container);
    } catch (_error) {
      warnOnce(
        "turnorder-parse",
        "A turn-order update could not be read; the next update will be retried.",
      );
      return false;
    }
    if (nonEmptyOnly && entries.length === 0) {
      return false;
    }
    var signature = turnSignature(entries);
    if (!force && signature === lastTurnSignature) {
      return false;
    }
    lastTurnSignature = signature;
    var wall = safeDateNow();
    var event = {
      seq: nextTurnorderSeq,
      t_wall_ms: wall,
      t_mono_ms: safePerformanceNow(),
      entries: entries,
      outerHTML: outerHTML(container),
    };
    nextTurnorderSeq += 1;
    state.turnorder_events.push(event);
    ensureCapturedAt(wall);
    capInMemory();
    persist();
    return true;
  }

  function observerConstructor() {
    try {
      return root.MutationObserver || root.WebKitMutationObserver || null;
    } catch (_error) {
      return null;
    }
  }

  function disconnect(observer) {
    try {
      if (observer && typeof observer.disconnect === "function") {
        observer.disconnect();
      }
    } catch (_error) {
      // Disconnect is best effort during a page rerender.
    }
  }

  function onChatMutations(records) {
    try {
      var elements = [];
      var seen = [];
      var i;
      for (i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.type === "characterData") {
          var characterMessage = closestMessage(record.target);
          if (characterMessage) {
            addUnique(elements, seen, characterMessage);
          }
        }
        var added = record.addedNodes || [];
        var j;
        for (j = 0; j < added.length; j += 1) {
          var fromNode = messageElementsFromNode(added[j]);
          var k;
          for (k = 0; k < fromNode.length; k += 1) {
            addUnique(elements, seen, fromNode[k]);
          }
        }
        if (record.target && elementMessageCandidate(record.target)) {
          addUnique(elements, seen, record.target);
        }
      }
      if (elements.length) {
        elements.sort(compareDomOrder);
        captureMessages(elements, true);
      }
    } catch (_error) {
      warnOnce(
        "chat-observer",
        "A chat mutation could not be captured; recording will continue on the next mutation.",
      );
    }
  }

  function onTurnorderMutations() {
    try {
      captureTurnorder(observedTurnorder, false);
    } catch (_error) {
      warnOnce(
        "turnorder-observer",
        "A turn-order mutation could not be captured; recording will continue on the next mutation.",
      );
    }
  }

  function makeObserver(callback) {
    var Constructor = observerConstructor();
    if (!Constructor) {
      warnOnce(
        "no-mutation-observer",
        "MutationObserver is unavailable; use dndCapture.dump() for a post-hoc capture.",
      );
      return null;
    }
    try {
      return new Constructor(callback);
    } catch (_error) {
      warnOnce(
        "observer-create",
        "MutationObserver could not be created; use dndCapture.dump() for a post-hoc capture.",
      );
      return null;
    }
  }

  function observeChat(container) {
    if (!container || observedChat === container) {
      return;
    }
    disconnect(chatObserver);
    chatObserver = makeObserver(onChatMutations);
    observedChat = container;
    if (!chatObserver) {
      return;
    }
    try {
      chatObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-messageid", "data-message-id", "data-playerid", "data-player-id"],
      });
    } catch (_error) {
      warnOnce(
        "chat-observe",
        "The chat container could not be observed; use dndCapture.dump() if needed.",
      );
      disconnect(chatObserver);
      chatObserver = null;
    }
  }

  function observeTurnorder(container) {
    if (!container || observedTurnorder === container) {
      return;
    }
    disconnect(turnorderObserver);
    observedTurnorder = container;
    turnorderObserver = makeObserver(onTurnorderMutations);
    if (!turnorderObserver) {
      return;
    }
    try {
      turnorderObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    } catch (_error) {
      // A restrictive observer shim may reject attributes; retry with the
      // essential child-list options before giving up.
      try {
        turnorderObserver.observe(container, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch (_retryError) {
        warnOnce("turnorder-observe", "The turn-order tracker could not be observed.");
        disconnect(turnorderObserver);
        turnorderObserver = null;
      }
    }
  }

  function observeDocumentRoot() {
    var rootNode = document.body || document.documentElement;
    if (!rootNode || observedRoot === rootNode) {
      return;
    }
    disconnect(rootObserver);
    observedRoot = rootNode;
    rootObserver = makeObserver(function onPageMutations() {
      try {
        attachObservers();
      } catch (_error) {
        warnOnce(
          "root-observer",
          "A page rerender could not be followed; the next mutation will retry it.",
        );
      }
    });
    if (!rootObserver) {
      return;
    }
    try {
      rootObserver.observe(rootNode, { childList: true, subtree: true });
    } catch (_error) {
      warnOnce("root-observe", "The page root could not be observed for Roll20 rerenders.");
      disconnect(rootObserver);
      rootObserver = null;
    }
  }

  function attachObservers() {
    if (!active) {
      return;
    }
    observeDocumentRoot();
    var chat = findChatContainer();
    if (chat) {
      var chatChanged = observedChat !== chat;
      if (observedChat && observedChat !== chat && !isConnected(observedChat)) {
        disconnect(chatObserver);
        observedChat = null;
      }
      observeChat(chat);
      if (chatChanged) {
        // A full chat-container replacement can arrive with already-rendered
        // messages before the new observer is attached.  Re-scan that subtree
        // so a Roll20 rerender cannot create a blind spot.
        captureMessages(messageElements(chat), true, true);
      }
    } else if (observedChat && !isConnected(observedChat)) {
      disconnect(chatObserver);
      observedChat = null;
    }

    var turnorder = findTurnorderContainer();
    if (turnorder) {
      var replaced = observedTurnorder && observedTurnorder !== turnorder;
      if (
        observedTurnorder &&
        replaced &&
        !isConnected(observedTurnorder) &&
        lastTurnSignature &&
        lastTurnSignature !== turnSignature([])
      ) {
        // A removed tracker represents a transition to an empty order.  This
        // makes combat-end inference possible even when Roll20 unmounts it.
        captureTurnorder(
          {
            querySelectorAll: function emptyQuery() {
              return [];
            },
            getAttribute: function noAttr() {
              return null;
            },
            outerHTML: "",
          },
          false,
        );
      }
      observeTurnorder(turnorder);
      if (!turnorderAttached) {
        turnorderAttached = true;
        captureTurnorder(turnorder, false, true);
      } else if (replaced) {
        captureTurnorder(turnorder, false, true);
      }
    } else if (observedTurnorder && !isConnected(observedTurnorder)) {
      disconnect(turnorderObserver);
      observedTurnorder = null;
      if (lastTurnSignature && lastTurnSignature !== turnSignature([])) {
        captureTurnorder(
          {
            querySelectorAll: function emptyQuery() {
              return [];
            },
            getAttribute: function noAttr() {
              return null;
            },
            outerHTML: "",
          },
          false,
        );
      }
      turnorderAttached = false;
    }
  }

  function stopImpl() {
    active = false;
    disconnect(chatObserver);
    disconnect(turnorderObserver);
    disconnect(rootObserver);
    chatObserver = null;
    turnorderObserver = null;
    rootObserver = null;
    observedChat = null;
    observedTurnorder = null;
    observedRoot = null;
    turnorderAttached = false;
    if (state.mode !== "live") {
      state.mode = "post-hoc";
    }
    persist();
    return statusImpl();
  }

  function startImpl() {
    active = true;
    state.mode = "live";
    turnorderAttached = false;
    var chat = findChatContainer();
    if (chat) {
      // Capturing the already-rendered backlog makes start() safe after a
      // reload and avoids a race with Roll20's first post-login rerender.
      captureMessages(messageElements(chat), false);
    } else {
      warnOnce(
        "chat-not-found",
        "Chat container not found yet; it will be picked up when Roll20 renders it.",
      );
    }
    attachObservers();
    persist();
    return statusImpl();
  }

  function dumpImpl() {
    var chat = findChatContainer();
    if (!chat) {
      warnOnce(
        "dump-chat-not-found",
        "Chat container was not found; no post-hoc messages were added.",
      );
    } else {
      captureMessages(messageElements(chat), false);
    }
    if (!active) {
      state.mode = "post-hoc";
    }
    persist();
    return snapshot();
  }

  function buildCapture() {
    if (!state.captured_at) {
      ensureCapturedAt(safeDateNow());
    }
    return {
      version: VERSION,
      captured_at: state.captured_at,
      mode: active ? "live" : state.mode,
      game_id: state.game_id,
      messages: state.messages.slice(),
      turnorder_events: state.turnorder_events.slice(),
    };
  }

  function triggerDownload(payload) {
    var json;
    try {
      json = JSON.stringify(payload, null, 2);
    } catch (_error) {
      warnOnce("save-serialise", "Could not serialise the capture for download.");
      return false;
    }
    try {
      if (
        root.navigator &&
        typeof root.navigator.msSaveBlob === "function" &&
        typeof Blob === "function"
      ) {
        root.navigator.msSaveBlob(
          new Blob([json], { type: "application/json" }),
          "roll20-capture.json",
        );
        return true;
      }
      if (
        typeof Blob !== "function" ||
        !root.URL ||
        typeof root.URL.createObjectURL !== "function"
      ) {
        throw new Error("Blob download APIs are unavailable");
      }
      var blob = new Blob([json], { type: "application/json" });
      var url = root.URL.createObjectURL(blob);
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "roll20-capture.json";
      anchor.rel = "noopener";
      if (typeof anchor.click === "function") {
        anchor.click();
      } else if (
        typeof anchor.dispatchEvent === "function" &&
        typeof root.MouseEvent === "function"
      ) {
        anchor.dispatchEvent(new root.MouseEvent("click"));
      } else {
        throw new Error("Anchor click API is unavailable");
      }
      if (typeof root.setTimeout === "function") {
        root.setTimeout(function revokeDownloadUrl() {
          try {
            root.URL.revokeObjectURL(url);
          } catch (_error) {
            // URL cleanup is best effort.
          }
        }, 1000);
      }
      return true;
    } catch (_error) {
      warnOnce(
        "save-download",
        "The browser could not start the JSON download; use the returned object as a fallback.",
      );
      return false;
    }
  }

  function saveImpl() {
    if (!active) {
      dumpImpl();
    }
    var payload = buildCapture();
    triggerDownload(payload);
    return payload;
  }

  function statusImpl() {
    var chat = findChatContainer();
    var turnorder = findTurnorderContainer();
    var result = {
      recording: active,
      mode: active ? "live" : state.mode,
      game_id: state.game_id,
      session_key: storageKey,
      messages: state.messages.length,
      turnorder_events: state.turnorder_events.length,
      chat_found: !!chat,
      turnorder_found: !!turnorder,
      storage_bytes: storageBytes,
      storage_cap_bytes: STORAGE_LIMIT_BYTES,
      storage_persisted: storagePersisted,
    };
    safeLog("info", "status", result);
    return result;
  }

  function clearImpl() {
    stopImpl();
    safeStorageRemove(storageKey);
    state = freshState(gameId);
    nextMessageSeq = 1;
    nextTurnorderSeq = 1;
    lastTurnSignature = null;
    turnorderAttached = false;
    storageBytes = 0;
    storagePersisted = false;
    return statusImpl();
  }

  function publicCall(fn, fallback) {
    try {
      return fn();
    } catch (_error) {
      warnOnce("public-call", "Capture command failed safely; recording can continue.");
      return fallback;
    }
  }

  function snapshot() {
    var payload = buildCapture();
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch (_error) {
      return payload;
    }
  }

  var gameId = gameIdFromLocation();
  storage = safeGetStorage();
  storageKey = sessionKeyForGame(gameId);
  var state = restore();
  gameId = state.game_id || gameId;
  storageKey = sessionKeyForGame(gameId);

  root.dndCapture = {
    __dndCapture: true,
    version: VERSION,
    start: function start() {
      return publicCall(startImpl, null);
    },
    stop: function stop() {
      return publicCall(stopImpl, null);
    },
    dump: function dump() {
      return publicCall(dumpImpl, null);
    },
    save: function save() {
      return publicCall(saveImpl, null);
    },
    status: function status() {
      return publicCall(statusImpl, null);
    },
    clear: function clear() {
      return publicCall(clearImpl, null);
    },
  };

  safeLog(
    "info",
    "ready. Run dndCapture.start() before the session, or dndCapture.dump() for the visible backlog.",
  );
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
