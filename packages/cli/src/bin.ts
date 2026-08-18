#!/usr/bin/env node
import { formatProgress, run } from "./cli.js";

const isTTY = process.stdout.isTTY === true;
const outcome = await run(process.argv.slice(2), process.cwd(), {
  isTTY,
  ...(isTTY
    ? {
        onProgress: (event: Parameters<typeof formatProgress>[0]) =>
          process.stdout.write(`${formatProgress(event)}\n`),
      }
    : {}),
});
process.stdout.write(outcome.stdout);
process.exitCode = outcome.exitCode;
