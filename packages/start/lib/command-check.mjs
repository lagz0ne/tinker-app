import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMainHost } from "./main-host.mjs";

// This native child runs no server socket and supplies no app configuration.
const { default: main } = await import(pathToFileURL(resolve(process.argv[2])).href);

const host = createMainHost(main, {
  env: {},
  args: ["--tinker-command-check"],
  stdout: process.stdout,
  stderr: process.stderr,
});

try {
  const app = await host.started;
  assert(app?.closed instanceof Promise, "command must return closed");
  if (process.argv[3] === "server") {
    assert.equal(typeof app.fetch, "function", "server must return fetch");
  }
  assert.equal(
    await host.closed,
    64,
    "command must reject unknown args with 64 and finish cleanup",
  );
  console.log("PASS command input/exit/close: " + process.argv[2]);
} catch (error) {
  host.stop(1, error);
  await host.closed;
  console.error(error);
  process.exitCode = 1;
}
