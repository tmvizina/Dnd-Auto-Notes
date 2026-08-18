#!/usr/bin/env node
// Thin launcher, committed rather than generated: npm only links a workspace
// bin whose target file exists at install time, so pointing `bin` straight at
// dist/ would leave `npx pipeline` unlinked on a clean checkout.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "bin.js");

if (!existsSync(entry)) {
  process.stderr.write("pipeline: not built yet — run `npm run build` from the repo root.\n");
  process.exit(1);
}

await import(pathToFileURL(entry).href);
