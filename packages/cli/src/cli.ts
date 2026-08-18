import { formatConfig, resolveConfig } from "./config.js";
import { PLANNED_COMMANDS, USAGE } from "./usage.js";

export const CLI_VERSION = "0.0.0";

export interface Outcome {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Pure argument handling, so behaviour is testable without spawning a process.
 * `bin.ts` is the only thing that touches stdout or the exit code.
 */
export function run(argv: readonly string[], cwd: string = process.cwd()): Outcome {
  const [first, ...rest] = argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return { stdout: USAGE, exitCode: 0 };
  }
  if (first === "--version" || first === "-v") {
    return { stdout: `${CLI_VERSION}\n`, exitCode: 0 };
  }
  if (first === "config") {
    return { stdout: `${formatConfig(resolveConfig(cwd))}\n`, exitCode: 0 };
  }

  const ticket = PLANNED_COMMANDS.get(first);
  if (ticket !== undefined) {
    const sub = rest.length > 0 ? ` ${rest.join(" ")}` : "";
    return {
      stdout: `pipeline ${first}${sub} is not implemented yet — it lands in ticket ${ticket}.\n`,
      exitCode: 1,
    };
  }

  return { stdout: `Unknown command: ${first}\n\n${USAGE}`, exitCode: 2 };
}
