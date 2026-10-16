// Node owns file-based env loading, command args, and process stop.
import { existsSync } from "node:fs";

import main from "../dist-cli/cli.js";

if (existsSync(".env")) process.loadEnvFile();
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

const cli = await main({
  env: process.env,
  args: process.argv.slice(2),
  signal: stop.signal,
  stdout: process.stdout,
  stderr: process.stderr,
});

await cli.closed;
