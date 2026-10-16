// This Node host is the entry seam for the separately built worker command.
import { existsSync } from "node:fs";

import main from "../dist-worker/worker.js";

if (existsSync(".env")) process.loadEnvFile();
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

const worker = await main({
  env: process.env,
  signal: stop.signal,
  stdout: process.stdout,
  stderr: process.stderr,
});

await worker.closed;
