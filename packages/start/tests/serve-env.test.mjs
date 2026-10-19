import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { baseDir } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

/** A built server whose main prints the NODE_ENV it loaded with, then ends the process. */
const reporting = (files = {}) =>
  fixture({
    "package.json": "{}",
    "dist/server/server.js":
      "export default async function main() { console.log(`NODE_ENV=${process.env.NODE_ENV}`); process.exit(0); }\n",
    ...files,
  });

const serve = (root, env) =>
  spawnSync(process.execPath, [join(baseDir, "bin/tinker.mjs"), "serve"], {
    cwd: root,
    encoding: "utf8",
    env,
  });

test("serve loads the app as production when NODE_ENV is not set", () => {
  const { NODE_ENV: _unset, ...env } = process.env;
  const ran = serve(reporting(), env);

  expect(ran.stdout).toBe("NODE_ENV=production\n");
});

test("serve keeps a NODE_ENV from the shell or the app's .env", () => {
  const { NODE_ENV: _unset, ...env } = process.env;

  expect(serve(reporting(), { ...env, NODE_ENV: "development" }).stdout).toBe(
    "NODE_ENV=development\n",
  );
  expect(serve(reporting({ ".env": "NODE_ENV=test\n" }), env).stdout).toBe("NODE_ENV=test\n");
});
