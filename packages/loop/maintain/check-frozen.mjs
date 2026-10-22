#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The loop's tests are its acceptance suite (docs/decisions/loop-on-tinker.md, ticket 5). After the
 * freeze, the *.test.mjs files do not change: the port changes only tests/api.mjs, the fixtures,
 * and setup. frozen.json holds each file's sha256; a changed, added, or removed file fails here.
 * Usage: node maintain/check-frozen.mjs [tests folder]
 */
const dir = process.argv[2] ?? join(import.meta.dirname, "../tests");
const frozen = JSON.parse(readFileSync(join(dir, "frozen.json"), "utf8"));

const now = Object.fromEntries(
  readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(dir, name)))
        .digest("hex"),
    ]),
);

const problems = [
  ...Object.keys(frozen.files)
    .filter((name) => !(name in now))
    .map((name) => `${name} is gone`),
  ...Object.entries(now)
    .filter(([name]) => !(name in frozen.files))
    .map(([name]) => `${name} is not in frozen.json`),
  ...Object.entries(now)
    .filter(([name, hash]) => name in frozen.files && frozen.files[name] !== hash)
    .map(([name]) => `${name} changed`),
];

for (const problem of problems) {
  process.stderr.write(`frozen: ${problem}; a frozen test does not change after ticket 5\n`);
}

if (problems.length > 0) process.exit(1);

process.stdout.write(
  `frozen: ${Object.keys(now).length} test files, ${frozen.tests} tests, unchanged\n`,
);
