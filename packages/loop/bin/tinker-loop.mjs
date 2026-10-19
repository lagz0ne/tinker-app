#!/usr/bin/env node
import { main } from "../lib/main.mjs";

/** Gates run in their own process group, so Ctrl-C reaches them only through this stop. */
const stop = new AbortController();
process.once("SIGINT", () => stop.abort("SIGINT"));
process.once("SIGTERM", () => stop.abort("SIGTERM"));

process.exitCode = await main({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stop.signal,
});
