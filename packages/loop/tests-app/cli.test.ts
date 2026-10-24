import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { expect, onTestFinished, test } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Test the native command contract.
import main from "../cmds/cli";
import { tempFolder } from "./temp";

const root = join(import.meta.dirname, "..");
const scaffold = join(root, "../../apps/start-scaffold");
const from = createRequire(join(root, "package.json"));
const g1 = "- `G1` Every gate in AGENTS.md passes.";

test("the app runs each command in the context's folder", async () => {
  const out: unknown[] = [];
  const err: unknown[] = [];
  const codes: number[] = [];

  const done = await main({
    env: {},
    args: ["rules", "G1"],
    cwd: scaffold,
    signal: new AbortController().signal,
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    exit: (code) => codes.push(code),
  });
  await done.closed;

  expect(codes).toEqual([0]);
  expect(err).toEqual([]);
  expect(out.join("")).toContain(`\n${g1}\n`);
});

test("tsx runs cmds/cli.ts from source through runMain; an unknown command exits 64", () => {
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

  const run = spawnSync(process.execPath, [from.resolve("tsx/cli"), entry, "frobnicate"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(run.stdout).toBe("");
  expect(run.stderr).toMatch(/^usage: tinker-loop check /);
  expect(run.status).toBe(64);
});

test("doctor passes on the loop app, its bin check included", () => {
  const doctor = spawnSync(
    process.execPath,
    [
      from.resolve("@tinker/start/package.json").replace("package.json", "bin/tinker.mjs"),
      "doctor",
    ],
    { cwd: root, encoding: "utf8" },
  );

  expect(doctor.stdout).toContain("doctor: all checks pass");
  expect(doctor.status).toBe(0);
});

test("the scaffold's tinker-loop runs the built app from the workspace", () => {
  const run = spawnSync(join(scaffold, "node_modules/.bin/tinker-loop"), ["rules", "G1"], {
    cwd: scaffold,
    encoding: "utf8",
  });

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(`\n${g1}\n`);
});

test("an operation's thrown Error prints tinker-loop: <message> on stderr and exits 78", async () => {
  const app = tempFolder();
  const out: unknown[] = [];
  const err: unknown[] = [];
  const codes: number[] = [];

  const done = await main({
    env: { PATH: process.env.PATH },
    args: ["rules"],
    cwd: app,
    signal: new AbortController().signal,
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    exit: (code) => codes.push(code),
  });
  await done.closed;

  expect(codes).toEqual([78]);
  expect(out).toEqual([]);
  expect(err).toEqual([
    `tinker-loop: cannot find @tinker/start from ${app}; install it to read its rules\n`,
  ]);
});

test("a stop while check waits for another tool's lock writes nothing and exits 130", async () => {
  const app = tempFolder();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: app });
  git("init", "--quiet");
  writeFileSync(join(app, "loop.json"), JSON.stringify({ gates: [{ name: "ok", run: "true" }] }));
  git("add", ".");
  git("commit", "--quiet", "-m", "one");
  const run = (signal: AbortSignal, out: string[]) =>
    main({
      env: { PATH: process.env.PATH },
      args: ["check"],
      cwd: app,
      signal,
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: () => true },
      exit: (code) => codes.push(code),
    });
  const codes: number[] = [];
  await (
    await run(new AbortController().signal, [])
  ).closed;
  const files = ["findings.jsonl", "last-check.json"].map((name) => join(app, ".loop", name));
  const before = files.map((path) => readFileSync(path, "utf8"));

  const lock = join(app, ".loop/findings.lock");
  writeFileSync(lock, "tool A");
  const stop = new AbortController();
  const out: string[] = [];
  const waiting = run(stop.signal, out);
  while (!out.join("").includes("checked") && !out.join("").includes("PASS ok")) await delay(20);
  await delay(300);
  stop.abort("SIGINT");
  rmSync(lock);
  await (
    await waiting
  ).closed;

  expect(codes).toEqual([0, 130]);
  expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
});
