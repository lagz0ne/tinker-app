import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { check } from "@/operations/check";
import { appDir, baseRef, childEnv, print, stop, warn } from "@/tags";

import { tempFolder, writeLoop } from "./temp";

/** A repo on branch work, one commit past main, that adds a Date.now() line. */
function repo() {
  const app = tempFolder();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: app,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(app, ".gitignore"), ".loop/\nred\nloop.json\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "one");

  git("checkout", "--quiet", "-b", "work");
  writeFileSync(join(app, "a.ts"), "const t = Date.now();\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "two");
  return { app, head: git("rev-parse", "HEAD") };
}

/** A gate that fails while the file `red` exists. */
const redGate = {
  name: "red",
  run: `${JSON.stringify(process.execPath)} -e "process.exit(require('fs').existsSync('red') ? 1 : 0)"`,
};

/**
 * Run the check operation.
 * @param app - From repo; why: the app to check.
 * @param options - From a test; why: --base, loop.json's base, and a stop.
 */
async function run(
  app: string,
  options: { base?: string | null; configured?: string | null; signal?: AbortSignal } = {},
) {
  writeLoop(app, {
    gates: [{ name: "ok", run: "true" }, redGate],
    base: "configured" in options ? (options.configured ?? null) : "main",
  });
  const out: string[] = [];
  const tags = [
    appDir(app),
    childEnv({ PATH: process.env.PATH }),
    baseRef(options.base ?? null),
    print((line) => out.push(line)),
    warn(() => {}),
    stop(options.signal ?? new AbortController().signal),
  ];
  const scope = createScope({ tags });

  const outcome = await scope.run(check);
  await scope.close();
  return { outcome, out };
}

/** @param app - From repo; why: the app whose findings to read. */
function findingsOf(app: string) {
  return readFileSync(join(app, ".loop/findings.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("check runs the gates, scans the change, merges, saves the last check, and prints the summary", async () => {
  const { app, head } = repo();
  writeFileSync(join(app, "red"), "");

  const { outcome, out } = await run(app);
  const rows = findingsOf(app);
  const last = JSON.parse(readFileSync(join(app, ".loop/last-check.json"), "utf8"));

  expect(outcome).toBe("red");
  expect(out.slice(0, 5)).toEqual([
    "PASS ok",
    "FAIL red",
    "scan base: main",
    "checked: . only",
    "tinker-loop check, round 1: 1 gates green, 1 red",
  ]);
  expect(out.slice(5, 8)).toEqual([
    "severity: important 1, question 1, nit 0, old 0",
    "status: open 2, answered 0, fixed 0",
    "open important:",
  ]);
  expect(out[8]).toMatch(/^ {2}G1 red: exited with code 1 \[[0-9a-f]{12}\]$/);
  expect(
    rows.map(({ rule, status, round, seenSha }) => ({ rule, status, round, seenSha })),
  ).toEqual([
    { rule: "G1", status: "open", round: 1, seenSha: head },
    { rule: "B3", status: "open", round: 1, seenSha: head },
  ]);
  expect(last).toMatchObject({
    round: 1,
    sha: head,
    tree: expect.stringMatching(/^[0-9a-f]{64}$/),
    gates: [
      { name: "ok", green: true },
      { name: "red", green: false },
    ],
  });
});

test("a later check fixes a gone gate finding, keeps an answer, and a skipped scan leaves scan rows", async () => {
  const { app } = repo();
  writeFileSync(join(app, "red"), "");
  await run(app);
  const answered = findingsOf(app).map((row) =>
    row.rule === "G1" ? { ...row, status: "answered", reason: "known" } : row,
  );
  writeFileSync(
    join(app, ".loop/findings.jsonl"),
    answered.map((row) => JSON.stringify(row)).join("\n"),
  );
  execFileSync("rm", [join(app, "red")]);

  const skipped = await run(app, { configured: null });
  const rows = findingsOf(app);
  const named = await run(app, { base: "nope" });

  expect(skipped.outcome).toBe("done");
  expect(skipped.out.slice(2, 4)).toEqual([
    "scan skipped: no base found; pass --base <ref>",
    "earlier scan findings stay as they are",
  ]);
  expect(rows.map(({ rule, status, round, reason }) => ({ rule, status, round, reason }))).toEqual([
    { rule: "G1", status: "fixed", round: 2, reason: "known" },
    { rule: "B3", status: "open", round: 1, reason: undefined },
  ]);
  expect(named.out[2]).toBe("scan skipped: git cannot find --base nope");
});

test("a stop during the gates writes nothing", async () => {
  const { app } = repo();
  const stopped = new AbortController();
  stopped.abort("SIGINT");

  const { outcome, out } = await run(app, { signal: stopped.signal });

  expect([outcome, out]).toEqual(["stopped", []]);
  expect(existsSync(join(app, ".loop/findings.jsonl"))).toBe(false);
  expect(existsSync(join(app, ".loop/last-check.json"))).toBe(false);
});
