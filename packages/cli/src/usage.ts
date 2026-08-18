export const USAGE = `pipeline — D&D Auto Notes

Usage:
  pipeline <command> [options]

Commands:
  config                      Print the resolved configuration and exit.
  session new <title>         Scaffold a session folder.               (P1-09)
  run --session <id>          Run pipeline stages for a session.       (P1-09)
  status --session <id>       Show per-stage state for a session.      (P1-09)
  qa --session <id>           Print the intake QA report.               (P1-09)
  notes --session <id>        Render session.md.                       (P3-08)
  label --session <id>        Hand-label utterances for calibration.   (P2-12)

Options:
  -h, --help                  Show this help.
  -v, --version               Show the CLI version.

Environment:
  DND_SESSIONS_ROOT           Override the sessions directory.
  DND_CAMPAIGN_ROOT           Override the campaign directory.
  DND_SIDECAR_PORT            Override the Python sidecar port (default 8477).

Future commands marked with a ticket id are not implemented yet; running one
prints the ticket that will deliver it.
`;

/** Commands the CLI knows about but has not implemented yet. */
export const PLANNED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["notes", "P3-08"],
  ["label", "P2-12"],
]);
