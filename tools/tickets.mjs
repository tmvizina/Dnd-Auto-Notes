#!/usr/bin/env node
// Reads the ticket backlog as data. Deliberately dependency-free: this runs at
// the top of every orchestrator session, before anything else is guaranteed.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VALID_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "changes_requested",
  "approved",
  "done",
  "blocked",
];

const TICKETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "tickets");
const TICKET_FILE = /^P\d-\d{2}-.*\.md$/;

function unquote(value) {
  return value.replace(/^["'](.*)["']$/, "$1");
}

/**
 * Enough YAML for this frontmatter and no more: scalars, inline arrays
 * (`[a, b]`) and block lists. A real parser would be a dependency, and the
 * schema is fixed by docs/tickets/README.md.
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;

  const fields = {};
  let listKey = null;

  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.trimStart().startsWith("#")) continue;

    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      fields[listKey].push(unquote(item[1]));
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    const value = rawValue.trim();

    if (value === "") {
      listKey = key;
      fields[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      listKey = null;
      const inner = value.slice(1, -1).trim();
      fields[key] = inner === "" ? [] : inner.split(",").map((v) => unquote(v.trim()));
    } else {
      listKey = null;
      fields[key] = unquote(value);
    }
  }
  return fields;
}

export function loadTickets(dir = TICKETS_DIR) {
  return readdirSync(dir)
    .filter((name) => TICKET_FILE.test(name))
    .sort()
    .map((name) => {
      const fields = parseFrontmatter(readFileSync(join(dir, name), "utf8"));
      if (fields === null)
        return { file: name, malformed: true, id: name, scope: [], dependsOn: [] };
      return {
        file: name,
        malformed: false,
        id: fields.id ?? "",
        phase: fields.phase ?? "",
        title: fields.title ?? "",
        status: fields.status ?? "",
        assignee: fields.assignee ?? "",
        dependsOn: Array.isArray(fields.depends_on) ? fields.depends_on : [],
        scope: Array.isArray(fields.scope) ? fields.scope : [],
        estimate: fields.estimate ?? "",
        commit: fields.commit ?? "",
        blockedReason: fields.blocked_reason ?? "",
      };
    });
}

/** The literal path prefix a glob can never escape, used for overlap tests. */
function staticPrefix(glob) {
  const cut = glob.search(/[*?[]/);
  const head = cut === -1 ? glob : glob.slice(0, cut);
  return head.replace(/[^/]*$/, "");
}

/**
 * Conservative: two scopes overlap when either's fixed prefix contains the
 * other's. It cannot miss a real overlap, and may flag a pair a full glob
 * intersection would clear — the safe direction for a boundary check.
 */
export function scopesOverlap(a, b) {
  const x = staticPrefix(a);
  const y = staticPrefix(b);
  return x.startsWith(y) || y.startsWith(x);
}

export function findCycles(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const state = new Map();
  const cycles = [];

  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      cycles.push([...trail.slice(trail.indexOf(id)), id].join(" -> "));
      return;
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) visit(dep, [...trail, id]);
    }
    state.set(id, "done");
  };

  for (const ticket of tickets) visit(ticket.id, []);
  return [...new Set(cycles)];
}

export function check(tickets) {
  const problems = [];
  const byId = new Map();

  for (const ticket of tickets) {
    if (ticket.malformed) {
      problems.push(`${ticket.file}: no parseable YAML frontmatter`);
      continue;
    }
    if (!ticket.id) problems.push(`${ticket.file}: missing id`);
    if (byId.has(ticket.id)) problems.push(`${ticket.file}: duplicate id ${ticket.id}`);
    byId.set(ticket.id, ticket);

    if (!VALID_STATUSES.includes(ticket.status)) {
      problems.push(`${ticket.id}: unknown status "${ticket.status}"`);
    }
    if (ticket.status === "done" && String(ticket.commit).trim() === "") {
      problems.push(`${ticket.id}: status is done but commit is empty`);
    }
    if (ticket.status === "blocked" && String(ticket.blockedReason).trim() === "") {
      problems.push(`${ticket.id}: status is blocked but no blocked_reason given`);
    }
    if (ticket.scope.length === 0) problems.push(`${ticket.id}: empty scope`);
  }

  const parsed = tickets.filter((t) => !t.malformed);
  for (const ticket of parsed) {
    for (const dep of ticket.dependsOn) {
      if (!byId.has(dep)) problems.push(`${ticket.id}: depends on unknown ticket ${dep}`);
    }
  }

  for (const cycle of findCycles(parsed)) problems.push(`dependency cycle: ${cycle}`);

  const active = parsed.filter((t) => t.status === "in_progress");
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      for (const a of active[i].scope) {
        for (const b of active[j].scope) {
          if (scopesOverlap(a, b)) {
            problems.push(
              `${active[i].id} and ${active[j].id} are both in_progress with overlapping scope: ${a} / ${b}`,
            );
          }
        }
      }
    }
  }

  return problems;
}

export function ready(tickets) {
  const statusById = new Map(tickets.map((t) => [t.id, t.status]));
  return tickets.filter(
    (t) => t.status === "todo" && t.dependsOn.every((dep) => statusById.get(dep) === "done"),
  );
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function main(argv) {
  const tickets = loadTickets();

  if (argv.includes("--check")) {
    const problems = check(tickets);
    if (problems.length === 0) {
      console.log(`${tickets.length} tickets, no problems.`);
      return 0;
    }
    console.error(`${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }

  if (argv.includes("--ready")) {
    const rows = ready(tickets).map((t) => [t.id, t.phase, t.estimate, t.title]);
    if (rows.length === 0) {
      console.log("Nothing ready: every todo ticket is waiting on a dependency.");
      return 0;
    }
    console.log(table(rows, ["ID", "PHASE", "EST", "TITLE"]));
    return 0;
  }

  const rows = tickets.map((t) => [
    t.id,
    t.phase,
    t.status,
    t.assignee || "-",
    t.commit || "-",
    t.blockedReason || t.title,
  ]);
  console.log(table(rows, ["ID", "PHASE", "STATUS", "ASSIGNEE", "COMMIT", "TITLE / BLOCKED"]));

  const counts = new Map();
  for (const t of tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  console.log(
    `\n${tickets.length} tickets: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
