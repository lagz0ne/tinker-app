import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { status } from "@/operations/status";
import { git } from "@/resources/git";
import { appDir, childEnv, print, warn } from "@/tags";

import { tempFolder } from "./temp";

const env = { PATH: process.env.PATH };

/** A git repo with one commit, and its HEAD and tree fingerprint. */
function repo() {
  const app = tempFolder();
  const run = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: app,
      encoding: "utf8",
    }).trim();
  run("init", "--quiet");
  writeFileSync(join(app, ".gitignore"), ".loop/\n");
  run("add", ".");
  run("commit", "--quiet", "-m", "one");

  mkdirSync(join(app, ".loop"));
  const scope = createScope({ tags: [appDir(app), childEnv(env)] });
  const fingerprint = scope.resolve(git).tree().fingerprint;
  void scope.close();
  return { app, head: run("rev-parse", "HEAD"), fingerprint };
}

/**
 * Write the loop files of an app.
 * @param app - From repo; why: the app.
 * @param files - From a test; why: the last check, findings, and review rounds to write.
 */
function state(app: string, files: { last?: object; findings?: object[]; rounds?: object[] }) {
  const lines = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  if (files.last) writeFileSync(join(app, ".loop/last-check.json"), JSON.stringify(files.last));
  writeFileSync(join(app, ".loop/findings.jsonl"), lines(files.findings ?? []));
  writeFileSync(join(app, ".loop/rounds.jsonl"), lines(files.rounds ?? []));
}

/** @param app - From repo; why: the app whose status to read. */
async function read(app: string) {
  const out: string[] = [];
  const tags = [appDir(app), childEnv(env), print((line) => out.push(line)), warn(() => {})];
  const scope = createScope({ tags });

  const outcome = scope.run(status);
  await scope.close();
  return { outcome, out };
}

const important = {
  id: "i1",
  rule: "B1",
  severity: "important",
  status: "open",
  file: "a.ts",
  line: 2,
  summary: "bad",
  source: "check",
};

test("done: the last check ran at HEAD on this tree, all gates green, nothing important open", async () => {
  const { app, head, fingerprint } = repo();
  state(app, {
    last: { round: 1, sha: head, tree: fingerprint, gates: [{ name: "ok", green: true }] },
  });

  expect(await read(app)).toEqual({
    outcome: "done",
    out: [`done: all gates green at ${head.slice(0, 12)}, no important finding open`],
  });
});

test("not done: no check, a moved HEAD, a changed tree, red gates, or open important findings", async () => {
  const { app, head, fingerprint } = repo();
  state(app, {});
  const none = await read(app);
  state(app, { last: { round: 1, sha: "f".repeat(40), tree: fingerprint, gates: [] } });
  const moved = await read(app);
  state(app, {
    last: {
      round: 1,
      sha: head,
      tree: "other",
      gates: [
        { name: "a", green: false },
        { name: "b", green: false },
      ],
    },
    findings: [important],
  });
  const red = await read(app);

  expect(none).toEqual({
    outcome: "notDone",
    out: ["not done: no check has run; run tinker-loop check"],
  });
  expect(moved.out).toEqual([
    `not done: the last check ran at ffffffffffff, but HEAD is ${head.slice(0, 12)}; run tinker-loop check`,
  ]);
  expect(red).toEqual({
    outcome: "notDone",
    out: [
      "open important B1 a.ts:2: bad [i1]",
      "not done: the tree changed since the last check; run tinker-loop check; 2 gates red in the last check: a, b; 1 important finding open",
    ],
  });
});

test("needs a person: an important review finding still open after 3 review rounds", async () => {
  const { app, head, fingerprint } = repo();
  const review = { ...important, id: "r1", source: "review" };
  const rounds = [2, 3, 3, 4].map((round) => ({ round, source: "review", sha: null }));
  state(app, {
    last: { round: 1, sha: head, tree: fingerprint, gates: [] },
    findings: [review],
    rounds,
  });

  expect(await read(app)).toEqual({
    outcome: "needsPerson",
    out: [
      "open important B1 a.ts:2: bad [r1]",
      "needs a person: 3 review rounds, and 1 important review finding still open",
    ],
  });
});
