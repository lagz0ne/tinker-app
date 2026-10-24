import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { answer } from "@/operations/answer";
import { appDir, childEnv, print, warn } from "@/tags";

import { tempFolder } from "./temp";

/** A git repo with two commits, a and b, and a findings file holding `rows(a)`. */
function repo(rows: (a: string) => object[]) {
  const app = tempFolder();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: app,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "a");
  const a = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "b");
  const b = git("rev-parse", "HEAD");

  mkdirSync(join(app, ".loop"));
  writeFileSync(
    join(app, ".loop/findings.jsonl"),
    rows(a)
      .map((row) => `${JSON.stringify(row)}\n`)
      .join(""),
  );
  return { app, a, b };
}

/**
 * Run the answer operation and keep what it printed, warned, and left in the file.
 * @param app - From repo; why: the app to answer in.
 * @param input - From a test; why: the answer, as the command line gave it.
 */
function run(app: string, input: { id: string; fixed?: boolean; sha?: string; reason?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const tags = [
    appDir(app),
    childEnv({ PATH: process.env.PATH }),
    print((line) => out.push(line)),
    warn((line) => err.push(line)),
  ];
  const scope = createScope({ tags });
  return Promise.resolve(scope.run(answer, { input: { fixed: false, ...input } })).then(
    async (outcome) => {
      await scope.close();
      const rows = readFileSync(join(app, ".loop/findings.jsonl"), "utf8").trim().split("\n");
      return {
        outcome,
        out,
        err,
        rows: rows.map((row) => JSON.parse(row) as Record<string, unknown>),
      };
    },
  );
}

test("--reason answers the finding, keeps the row, and drops what a check saw of it", async () => {
  const { app } = repo(() => [{ id: "x", status: "open", sha: "s", dirty: true, rule: "B1" }]);

  expect(await run(app, { id: "x", reason: "  on purpose  " })).toEqual({
    outcome: "done",
    out: ["answered x: on purpose"],
    err: [],
    rows: [{ id: "x", status: "answered", reason: "on purpose", rule: "B1" }],
  });
});

test("--fixed takes HEAD, or the --sha commit, after the commit where the finding was seen", async () => {
  const { app, a, b } = repo((a) => [
    { id: "x", status: "open", seenSha: a },
    { id: "y", status: "open" },
  ]);

  const head = await run(app, { id: "x", fixed: true });
  const named = await run(app, { id: "y", fixed: true, sha: b });

  expect(head.out).toEqual([`fixed x at ${b.slice(0, 12)}`]);
  expect(named.out).toEqual([`fixed y at ${b.slice(0, 12)}`]);
  expect(named.rows).toEqual([
    { id: "x", status: "fixed", seenSha: a, sha: b },
    { id: "y", status: "fixed", sha: b },
  ]);
});

test("a bad answer is refused on warn and changes nothing", async () => {
  const { app, a } = repo((a) => [
    { id: "x", status: "open", seenSha: a },
    { id: "y", status: "open" },
  ]);
  const cases = [
    { id: "x" },
    { id: "x", fixed: true, reason: "both" },
    { id: "x", sha: a, reason: "sha without fixed" },
    { id: "x", reason: "  " },
    { id: "nope", reason: "why" },
    { id: "x", fixed: true, sha: "no-such-ref" },
    { id: "x", fixed: true, sha: a },
    { id: "y", fixed: true },
  ];

  const runs = [];
  for (const input of cases) runs.push(await run(app, input));

  expect(runs.map(({ outcome }) => outcome)).toEqual(cases.map(() => "refused"));
  expect(runs.map(({ err }) => err.join(""))).toEqual([
    "tinker-loop answer: give --fixed or --reason, one of them",
    "tinker-loop answer: give --fixed or --reason, one of them",
    "tinker-loop answer: --sha goes with --fixed",
    "tinker-loop answer: --reason needs text",
    "tinker-loop answer: no finding has id nope",
    "tinker-loop answer: no-such-ref is not a commit",
    `tinker-loop answer: finding x was seen at ${a.slice(0, 12)}; commit the fix after it, then answer`,
    "tinker-loop answer: finding y has no seenSha, so no tool recorded where it was seen; name the fix commit with --sha",
  ]);
  expect(runs.at(-1)?.rows).toEqual([
    { id: "x", status: "open", seenSha: a },
    { id: "y", status: "open" },
  ]);
});
