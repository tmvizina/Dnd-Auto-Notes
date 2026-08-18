import { describe, expect, it } from "vitest";
import {
  decisionsForSuggestions,
  isMappingCode,
  orderQaEntries,
  type IntakeQaEntry,
  type MappingSuggestion,
} from "./Intake.js";

const entry = (severity: IntakeQaEntry["severity"], code: string): IntakeQaEntry => ({
  severity,
  code,
  message: `${code} message`,
  hint: `${code} hint`,
});

describe("intake page model", () => {
  it("keeps QA errors ahead of warnings and informational hints", () => {
    expect(
      orderQaEntries([
        entry("info", "INFO"),
        entry("error", "ERROR"),
        entry("warning", "WARN"),
      ]).map((item) => item.code),
    ).toEqual(["ERROR", "WARN", "INFO"]);
    expect(orderQaEntries([entry("error", "MISSING")])[0]?.hint).toBe("MISSING hint");
  });

  it("never auto-applies ranked mapping suggestions", () => {
    const suggestions: readonly MappingSuggestion[] = [
      {
        observed: "track-a",
        kind: "discord",
        exact: null,
        candidates: [{ playerId: "p1", displayName: "Player", score: 0.9, matchedOn: "hint" }],
      },
    ];
    expect(decisionsForSuggestions(suggestions, new Map())).toEqual([
      { observed: "track-a", kind: "discord", playerId: null },
    ]);
    expect(isMappingCode("UNMAPPED_DISCORD")).toBe(true);
    expect(isMappingCode("TRACK_NAME_UNPARSED")).toBe(true);
  });
});
