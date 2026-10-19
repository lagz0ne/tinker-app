#!/usr/bin/env node
import { main } from "../lib/main.mjs";

process.exitCode = await main({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
