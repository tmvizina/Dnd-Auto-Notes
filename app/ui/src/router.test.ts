import { describe, expect, it } from "vitest";
import { hashForRoute, routeFromHash } from "./router.js";

describe("hash routing", () => {
  it.each([
    ["", "sessions"],
    ["#", "sessions"],
    ["#/sessions", "sessions"],
    ["#/review", "review"],
    ["#/notes", "notes"],
    ["#/settings", "settings"],
    ["#/notes/utterances", "notes"],
    ["#/not-a-page", "sessions"],
  ] as const)("restores %s as %s", (hash, expected) => {
    expect(routeFromHash(hash)).toBe(expected);
  });

  it.each(["sessions", "review", "notes", "settings"] as const)(
    "formats the %s route as a stable hash",
    (route) => {
      expect(hashForRoute(route)).toBe(`#/${route}`);
    },
  );
});
