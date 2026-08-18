import { describe, expect, it } from "vitest";
import type { Ticket } from "../tools/tickets.mjs";
import {
  check,
  findCycles,
  loadTickets,
  parseFrontmatter,
  ready,
  scopesOverlap,
} from "../tools/tickets.mjs";

function ticket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    file: `${overrides.id}-x.md`,
    malformed: false,
    phase: "0",
    title: "t",
    status: "todo",
    assignee: "",
    dependsOn: [],
    scope: [`packages/${overrides.id}/**`],
    estimate: "S",
    commit: "",
    blockedReason: "",
    ...overrides,
  };
}

describe("parseFrontmatter", () => {
  const FRONTMATTER = [
    "---",
    "id: P1-03",
    "depends_on: [P0-06, P1-01]",
    "scope:",
    "  - a/**",
    "  - b/**",
    'commit: ""',
    "---",
    "body",
  ].join("\n");

  it("reads scalars, inline arrays and block lists", () => {
    const fields = parseFrontmatter(FRONTMATTER);
    expect(fields).not.toBeNull();
    expect(fields?.["id"]).toBe("P1-03");
    expect(fields?.["depends_on"]).toEqual(["P0-06", "P1-01"]);
    expect(fields?.["scope"]).toEqual(["a/**", "b/**"]);
    expect(fields?.["commit"]).toBe("");
  });

  it("treats an empty inline array as no dependencies", () => {
    const fields = parseFrontmatter(["---", "id: P0-01", "depends_on: []", "---"].join("\n"));
    expect(fields?.["depends_on"]).toEqual([]);
  });

  it("returns null when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading")).toBeNull();
  });
});

describe("ready", () => {
  it("lists exactly the todo tickets whose dependencies are all done", () => {
    const tickets = [
      ticket({ id: "A", status: "done", commit: "abc1234" }),
      ticket({ id: "B", status: "todo", dependsOn: ["A"] }),
      ticket({ id: "C", status: "todo", dependsOn: ["B"] }),
      ticket({ id: "D", status: "in_progress", dependsOn: ["A"] }),
      ticket({ id: "E", status: "todo" }),
    ];
    expect(ready(tickets).map((t: Ticket) => t.id)).toEqual(["B", "E"]);
  });

  it("does not treat an in_progress dependency as satisfied", () => {
    const tickets = [
      ticket({ id: "A", status: "in_progress" }),
      ticket({ id: "B", status: "todo", dependsOn: ["A"] }),
    ];
    expect(ready(tickets)).toHaveLength(0);
  });
});

describe("check", () => {
  it("reports an unknown dependency id", () => {
    const problems = check([ticket({ id: "A", dependsOn: ["NOPE"] })]);
    expect(problems.some((p: string) => p.includes("depends on unknown ticket NOPE"))).toBe(true);
  });

  it("reports a dependency cycle", () => {
    const problems = check([
      ticket({ id: "A", dependsOn: ["B"] }),
      ticket({ id: "B", dependsOn: ["A"] }),
    ]);
    expect(problems.some((p: string) => p.startsWith("dependency cycle:"))).toBe(true);
  });

  it("finds a longer cycle too", () => {
    const cycles = findCycles([
      ticket({ id: "A", dependsOn: ["B"] }),
      ticket({ id: "B", dependsOn: ["C"] }),
      ticket({ id: "C", dependsOn: ["A"] }),
    ]);
    expect(cycles).toHaveLength(1);
  });

  it("reports a done ticket with no commit", () => {
    const problems = check([ticket({ id: "A", status: "done" })]);
    expect(problems).toContain("A: status is done but commit is empty");
  });

  it("accepts a done ticket that records its commit", () => {
    expect(check([ticket({ id: "A", status: "done", commit: "55541d9" })])).toEqual([]);
  });

  it("reports an unknown status", () => {
    const problems = check([ticket({ id: "A", status: "nearly" })]);
    expect(problems).toContain('A: unknown status "nearly"');
  });

  it("requires a reason on a blocked ticket", () => {
    expect(check([ticket({ id: "A", status: "blocked" })])).toContain(
      "A: status is blocked but no blocked_reason given",
    );
  });

  it("reports overlapping scope between two in_progress tickets", () => {
    const problems = check([
      ticket({ id: "A", status: "in_progress", scope: ["packages/core/src/**"] }),
      ticket({ id: "B", status: "in_progress", scope: ["packages/core/src/stage/**"] }),
    ]);
    expect(problems.some((p: string) => p.includes("overlapping scope"))).toBe(true);
  });

  it("allows disjoint scope between two in_progress tickets", () => {
    expect(
      check([
        ticket({ id: "A", status: "in_progress", scope: ["packages/core/src/intake/**"] }),
        ticket({ id: "B", status: "in_progress", scope: ["packages/core/src/render/**"] }),
      ]),
    ).toEqual([]);
  });

  it("ignores scope overlap when only one ticket is in_progress", () => {
    expect(
      check([
        ticket({ id: "A", status: "in_progress", scope: ["packages/core/src/**"] }),
        ticket({ id: "B", status: "todo", scope: ["packages/core/src/stage/**"] }),
      ]),
    ).toEqual([]);
  });
});

describe("scopesOverlap", () => {
  it.each([
    ["packages/core/src/**", "packages/core/src/stage/**", true],
    ["packages/core/**", "packages/cli/**", false],
    ["package.json", "package.json", true],
    ["packages/core/src/a.ts", "packages/core/src/b.ts", true],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(scopesOverlap(a as string, b as string)).toBe(expected);
  });
});

describe("the real backlog", () => {
  it("parses every ticket file", () => {
    const tickets = loadTickets();
    expect(tickets.length).toBeGreaterThanOrEqual(52);
    expect(tickets.filter((t: Ticket) => t.malformed)).toEqual([]);
  });

  it("has no unknown dependencies and no cycles", () => {
    const tickets = loadTickets().filter((t: Ticket) => !t.malformed);
    const ids = new Set(tickets.map((t: Ticket) => t.id));
    for (const t of tickets) {
      for (const dep of t.dependsOn) expect(ids.has(dep)).toBe(true);
    }
    expect(findCycles(tickets)).toEqual([]);
  });
});
