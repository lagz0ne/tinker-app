import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, onTestFinished, test } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Test the native command contract.
import main from "../cmds/cli";

const root = join(import.meta.dirname, "..");

const said =
  "tinker-loop check: the app has no commands yet; bin/tinker-loop.mjs runs lib/ until ticket 8\n";

test("the skeleton has no commands yet: any input says so on stderr and exits 64", async () => {
  const out: unknown[] = [];
  const err: unknown[] = [];
  const codes: number[] = [];

  const done = await main({
    env: {},
    args: ["check"],
    cwd: root,
    signal: new AbortController().signal,
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    exit: (code) => codes.push(code),
  });
  await done.closed;

  expect(codes).toEqual([64]);
  expect(out).toEqual([]);
  expect(err).toEqual([said]);
});

test("tsx runs cmds/cli.ts from source through runMain, with its ~/ imports", () => {
  const from = createRequire(join(root, "package.json"));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-tsx-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "run.mjs");
  writeFileSync(
    entry,
    [
      `import { runMain } from ${JSON.stringify(pathToFileURL(from.resolve("@tinker/start/main-host")).href)};`,
      `import main from ${JSON.stringify(pathToFileURL(join(root, "cmds/cli.ts")).href)};`,
      "await runMain(main);",
      "",
    ].join("\n"),
  );

  const run = spawnSync(process.execPath, [from.resolve("tsx/cli"), entry, "check"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(run.stdout).toBe("");
  expect(run.stderr).toBe(said);
  expect(run.status).toBe(64);
});
