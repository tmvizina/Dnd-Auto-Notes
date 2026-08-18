// Hand-written types for the dependency-free tools/tickets.mjs, so the tests
// (and any future consumer) are checked rather than silently `any`.

export interface Ticket {
  readonly file: string;
  readonly malformed: boolean;
  readonly id: string;
  readonly phase: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string;
  readonly dependsOn: readonly string[];
  readonly scope: readonly string[];
  readonly estimate: string;
  readonly commit: string;
  readonly blockedReason: string;
}

export declare const VALID_STATUSES: readonly string[];

/** Returns null when the file has no parseable frontmatter block. */
export declare function parseFrontmatter(text: string): Record<string, string | string[]> | null;

export declare function loadTickets(dir?: string): Ticket[];

/** Conservative prefix-based overlap: never misses a real one, may over-report. */
export declare function scopesOverlap(a: string, b: string): boolean;

export declare function findCycles(tickets: readonly Ticket[]): string[];

/** Human-readable problems; empty means the backlog is consistent. */
export declare function check(tickets: readonly Ticket[]): string[];

/** `todo` tickets whose every dependency is `done`. */
export declare function ready(tickets: readonly Ticket[]): Ticket[];

export declare function main(argv: readonly string[]): number;
