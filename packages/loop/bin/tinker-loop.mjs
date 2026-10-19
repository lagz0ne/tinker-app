#!/usr/bin/env node
import { main } from "../lib/main.mjs";

/** Gates run in their own process group, so a hangup or Ctrl-C reaches them only through this stop. */
const stop = new AbortController();

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop.abort(signal));
}

process.exitCode = await main({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stop.signal,
});
