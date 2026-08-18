import { describe, expect, it } from "vitest";
import { filterAndSortSessions } from "./Sessions.js";
import type { SessionSummary } from "../../../desktop/src/shared/contracts.js";

function session(sessionId: string, date: string, grade: string | null): SessionSummary {
  return {
    sessionId,
    title: sessionId,
    number: null,
    date,
    durationS: null,
    status: "new",
    grade,
    hasNotes: false,
  };
}

describe("sessions page list model", () => {
  it("sorts newest first without mutating the folder-index response", () => {
    const input = [session("older", "2026-01-01", null), session("newer", "2026-02-01", "A")];
    const result = filterAndSortSessions(input, {
      dateOrder: "newest",
      grade: "all",
      fromDate: "",
      toDate: "",
    });
    expect(result.map((item) => item.sessionId)).toEqual(["newer", "older"]);
    expect(input.map((item) => item.sessionId)).toEqual(["older", "newer"]);
  });

  it("filters pending QA and date bounds", () => {
    const result = filterAndSortSessions(
      [
        session("pending", "2026-01-10", null),
        session("graded", "2026-01-20", "B"),
        session("outside", "2026-03-01", "B"),
      ],
      { dateOrder: "oldest", grade: "pending", fromDate: "2026-01-01", toDate: "2026-02-01" },
    );
    expect(result.map((item) => item.sessionId)).toEqual(["pending"]);
  });
});
