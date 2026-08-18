import { describe, expect, it } from "vitest";
import { getVirtualRange, virtualRowCount } from "./virtual-list.js";

describe("virtual list range", () => {
  it("keeps a 5,000-row list bounded to the viewport", () => {
    const range = getVirtualRange({
      count: 5_000,
      rowHeight: 72,
      scrollTop: 0,
      viewportHeight: 480,
    });

    expect(range.totalHeight).toBe(360_000);
    expect(range.start).toBe(0);
    expect(virtualRowCount(range)).toBeLessThan(30);
  });

  it("moves the bounded window when scrolling", () => {
    const range = getVirtualRange({
      count: 5_000,
      rowHeight: 72,
      scrollTop: 72 * 2_000,
      viewportHeight: 480,
      overscan: 4,
    });

    expect(range.start).toBe(1_996);
    expect(range.end).toBe(2_011);
    expect(range.offsetTop).toBe(72 * 1_996);
  });

  it("handles an empty list without producing a negative range", () => {
    const range = getVirtualRange({
      count: 0,
      rowHeight: 72,
      scrollTop: 100,
      viewportHeight: 480,
    });

    expect(range).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  });
});
