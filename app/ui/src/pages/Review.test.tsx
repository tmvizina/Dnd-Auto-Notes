import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewPage, reviewKeyAction } from "./Review.js";
import type { RendererTransport } from "../transport.js";

describe("review page", () => {
  it("renders an accessible empty state before a session is selected", () => {
    const html = renderToStaticMarkup(
      <ReviewPage sessionId={null} transport={{} as RendererTransport} />,
    );
    expect(html).toContain("No session selected");
    expect(html).toContain("Choose a session before reviewing flagged spans.");
  });
});

/**
 * Reviewing 150 flags has to take minutes, which makes the bindings the
 * feature rather than a convenience. They live in a pure function so they can
 * be asserted without a DOM, matching how `ClipUrlRegistry` is tested.
 */
describe("review keyboard bindings", () => {
  const context = { hasFlags: true, hasSession: true, hasJournal: true };

  it("plays on both space and p", () => {
    // "p" used to move to the previous flag, duplicating ArrowLeft and leaving
    // play reachable only from the space bar.
    expect(reviewKeyAction(" ", context)).toEqual({ kind: "play" });
    expect(reviewKeyAction("p", context)).toEqual({ kind: "play" });
  });

  it("moves through the list with arrows and n", () => {
    expect(reviewKeyAction("ArrowRight", context)).toEqual({ kind: "next" });
    expect(reviewKeyAction("n", context)).toEqual({ kind: "next" });
    expect(reviewKeyAction("ArrowLeft", context)).toEqual({ kind: "previous" });
  });

  it("maps the number row to candidates, one-based", () => {
    expect(reviewKeyAction("1", context)).toEqual({ kind: "candidate", index: 0 });
    expect(reviewKeyAction("9", context)).toEqual({ kind: "candidate", index: 8 });
    // 0 is not a candidate key; treating it as index -1 would resolve a flag
    // against nothing.
    expect(reviewKeyAction("0", context)).toBeNull();
  });

  it("covers every resolution action without a mouse", () => {
    expect(reviewKeyAction("o", context)).toEqual({ kind: "out_of_character" });
    expect(reviewKeyAction("u", context)).toEqual({ kind: "unresolvable" });
    expect(reviewKeyAction("b", context)).toEqual({ kind: "bulk" });
    expect(reviewKeyAction("r", context)).toEqual({ kind: "rerun" });
    expect(reviewKeyAction("v", context)).toEqual({ kind: "revert" });
  });

  it("does nothing at all when there are no flags", () => {
    const empty = { ...context, hasFlags: false };
    for (const key of [" ", "p", "n", "ArrowLeft", "1", "o", "u", "b", "r", "v"])
      expect(reviewKeyAction(key, empty)).toBeNull();
  });

  it("withholds rerun and revert until they are actually available", () => {
    expect(reviewKeyAction("r", { ...context, hasSession: false })).toBeNull();
    // Reverting without a journal id would ask the main process to undo
    // nothing in particular.
    expect(reviewKeyAction("v", { ...context, hasJournal: false })).toBeNull();
    expect(reviewKeyAction("v", { ...context, hasSession: false })).toBeNull();
  });

  it("ignores keys it does not bind", () => {
    for (const key of ["q", "Escape", "Enter", "F5", "Shift"])
      expect(reviewKeyAction(key, context)).toBeNull();
  });
});
