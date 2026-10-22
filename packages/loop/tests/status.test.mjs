import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { recordReviewRound } from "./api.mjs";
import {
  commit,
  fail,
  findingsOf,
  git,
  loop,
  loopJson,
  pass,
  repo,
  setFindings,
} from "./fixture.mjs";

/**
 * A finding row, as a tool writes it.
 * @param {string} id - From a test; why: names the row.
 * @param {object} fields - From a test; why: the row's source, round, severity, and status.
 */
function row(id, fields) {
  return { id, rule: "C3", file: "src/x.ts", line: 1, summary: `${id} broke`, ...fields };
}

/**
 * @param {number} round - From a test; why: the review round.
 * @param {string} status - From a test; why: open, fixed, or answered.
 */
function review(round, status = "open") {
  return row(`review-${round}`, { source: "review", round, severity: "important", status });
}

test("no check yet is not done", async () => {
  const run = await loop(repo({ "readme.md": "" }), "status");

  expect(run.code).toBe(1);
  expect(run.stdout).toBe("not done: no check has run; run tinker-loop check\n");
});

test("a green check at HEAD with no important finding open is done", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  setFindings(app, [
    row("ask", { source: "check", round: 1, severity: "question", status: "open" }),
    row("style", { source: "review", round: 1, severity: "nit", status: "open" }),
    review(1, "fixed"),
  ]);

  const run = await loop(app, "status");

  expect(run.code).toBe(0);
  expect(run.stdout).toMatch(
    /^done: all gates green at [0-9a-f]{12}, no important finding open\n$/,
  );
});

test("a red gate is not done, and each open important finding gets a line", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail, ok: pass }) });
  await loop(app, "check");
  const [gate] = findingsOf(app);

  const run = await loop(app, "status");

  expect(run.code).toBe(1);
  expect(run.stdout).toBe(
    [
      `open important G1 red: exited with code 1 [${gate.id}]`,
      "not done: 1 gate red in the last check: red; 1 important finding open",
      "",
    ].join("\n"),
  );
});

test("an answered red gate is still not done: the last check had a red gate", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  await loop(app, "answer", findingsOf(app)[0].id, "--reason", "known red");

  const run = await loop(app, "status");

  expect(run.code).toBe(1);
  expect(run.stdout).toBe("not done: 1 gate red in the last check: red\n");
});

test("a check before the latest commit is not done", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  commit(app, { more: "" }, "more work");

  const run = await loop(app, "status");

  expect(run.code).toBe(1);
  expect(run.stdout).toMatch(
    /^not done: the last check ran at [0-9a-f]{12}, but HEAD is [0-9a-f]{12}; run tinker-loop check\n$/,
  );
});

test("an open important review finding is not done", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  setFindings(app, [review(1)]);

  const run = await loop(app, "status");

  expect(run.code).toBe(1);
  expect(run.stdout).toBe(
    [
      "open important C3 src/x.ts:1: review-1 broke [review-1]",
      "not done: 1 important finding open",
      "",
    ].join("\n"),
  );
});

test("one review finding open across 3 recorded review rounds needs a person", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  const sha = git(app, "rev-parse", "HEAD");
  const rounds = [];
  for (let round = 0; round < 3; round += 1) rounds.push(await recordReviewRound(app, { sha }));
  setFindings(app, [review(rounds[0])]);

  const run = await loop(app, "status");

  expect(rounds).toEqual([2, 3, 4]);
  expect(run.code).toBe(2);
  expect(run.stdout).toContain(
    "needs a person: 3 review rounds, and 1 important review finding still open\n",
  );
});

test("a red gate alone after 3 review rounds is not done, not a person", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  const sha = git(app, "rev-parse", "HEAD");
  for (let round = 0; round < 3; round += 1) await recordReviewRound(app, { sha });
  setFindings(app, [
    ...findingsOf(app),
    review(2, "fixed"),
    { ...review(3, "answered"), id: "r3" },
  ]);

  const run = await loop(app, "status");

  expect(run.code).toBe(1);
  expect(run.stdout).toContain(
    "not done: 1 gate red in the last check: red; 1 important finding open\n",
  );
});

test("fewer than 3 recorded rounds is not done; all closed after 3 rounds is done", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  const sha = git(app, "rev-parse", "HEAD");
  await recordReviewRound(app, { sha });
  await recordReviewRound(app, { sha });
  setFindings(app, [review(2)]);
  const two = await loop(app, "status");

  await recordReviewRound(app, { sha });
  setFindings(app, [review(2, "fixed")]);
  const closed = await loop(app, "status");

  expect([two.code, closed.code]).toEqual([1, 0]);
});

test("a check after a recorded review round takes the next round number", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  await recordReviewRound(app, { sha: null });

  const run = await loop(app, "check");

  expect(run.stdout).toContain("tinker-loop check, round 3:");
  expect(readFileSync(join(app, ".loop/rounds.jsonl"), "utf8")).toBe(
    '{"round":2,"source":"review","sha":null}\n',
  );
});

test("an edit after a green check is not done until check runs again", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }), "src.txt": "one\n" });
  await loop(app, "check");
  const green = await loop(app, "status");

  writeFileSync(join(app, "src.txt"), "one\ntwo\n");
  const edited = await loop(app, "status");
  writeFileSync(join(app, "src.txt"), "one\n");
  writeFileSync(join(app, "new.txt"), "new\n");
  const added = await loop(app, "status");
  await loop(app, "check");
  const checked = await loop(app, "status");

  expect([green.code, edited.code, added.code, checked.code]).toEqual([0, 1, 1, 0]);
  expect(edited.stdout).toBe(
    "not done: the tree changed since the last check; run tinker-loop check\n",
  );
});

test("files a gate writes do not block done", async () => {
  const write = `node -e "require('fs').writeFileSync('report.txt', String(Date.now()))"`;
  const app = repo({ "loop.json": loopJson({ write }) });

  const run = await loop(app, "check");
  const status = await loop(app, "status");

  expect(run.code).toBe(0);
  expect(status.code).toBe(0);
  expect(status.stdout).toMatch(/^done: /);
});

test("a check on an unchanged dirty tree is done; a commit after it is not", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }), "src.txt": "one\n" });
  writeFileSync(join(app, "src.txt"), "one\ntwo\n");
  await loop(app, "check");
  const dirty = await loop(app, "status");

  commit(app, {}, "commit the checked edit");
  const committed = await loop(app, "status");

  expect(dirty.code).toBe(0);
  expect(committed.code).toBe(1);
  expect(committed.stdout).toMatch(
    /^not done: the last check ran at [0-9a-f]{12}, but HEAD is [0-9a-f]{12}; run tinker-loop check\n$/,
  );
});

test("check rewrites a broken last-check.json; a broken rounds.jsonl names the line to fix", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  writeFileSync(join(app, ".loop/last-check.json"), "{bad");
  const last = await loop(app, "status");
  const check = await loop(app, "check");
  const repaired = await loop(app, "status");
  writeFileSync(join(app, ".loop/rounds.jsonl"), '{"round":1}\n{"round":"two"}\n');
  const rounds = await loop(app, "status");

  expect([last.code, check.code, repaired.code, rounds.code]).toEqual([78, 0, 0, 78]);
  expect(last.stderr).toMatch(
    /\.loop\/last-check\.json: .*; run tinker-loop check to write it again\n$/,
  );
  expect(rounds.stderr).toContain(
    "rounds.jsonl:2 is not a round: one JSON object with a whole-number round; fix or delete that line",
  );
});

test("status takes no IDs and no other flags", async () => {
  const app = repo({ "readme.md": "" });

  const ids = await loop(app, "status", "B1");
  const flag = await loop(app, "status", "--open");

  expect([ids.code, flag.code]).toEqual([64, 64]);
  expect(flag.stderr).toContain("tinker-loop status does not take --open");
});
