#!/usr/bin/env node
import { run } from "./cli.js";

const outcome = run(process.argv.slice(2));
process.stdout.write(outcome.stdout);
process.exitCode = outcome.exitCode;
