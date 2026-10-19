#!/usr/bin/env node
import { main } from "../lib/main.mjs";

/** Gates run in their own process group, so a hangup or Ctrl-C reaches them only through this stop. */
const stop = new AbortController();

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop.abort(signal));
}

/** A reader that quits early, such as `head`, closes the pipe; the rest of the output is not needed. */
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

process.exitCode = await main({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stop.signal,
});
