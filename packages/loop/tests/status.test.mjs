import { expect, test } from "vite-plus/test";

import { commit, fail, findingsOf, loop, loopJson, pass, repo, setFindings } from "./fixture.mjs";

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

test("3 review rounds with an important finding still open needs a person", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  setFindings(app, [review(1, "fixed"), review(2, "answered"), review(3)]);

  const run = await loop(app, "status");

  expect(run.code).toBe(2);
  expect(run.stdout).toContain(
    "needs a person: 3 review rounds, and 1 important finding still open\n",
  );
});

test("review rounds are distinct round numbers, and a person is needed only while open", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  const sameRound = [
    review(1),
    { ...review(1), id: "review-1b" },
    { ...review(1), id: "review-1c" },
  ];
  setFindings(app, sameRound);
  const one = await loop(app, "status");
  setFindings(app, [review(1), review(2)]);
  const two = await loop(app, "status");
  setFindings(app, [review(1, "fixed"), review(2, "fixed"), review(3, "answered")]);
  const closed = await loop(app, "status");

  expect([one.code, two.code, closed.code]).toEqual([1, 1, 0]);
});

test("status takes no IDs and no other flags", async () => {
  const app = repo({ "readme.md": "" });

  const ids = await loop(app, "status", "B1");
  const flag = await loop(app, "status", "--open");

  expect([ids.code, flag.code]).toEqual([64, 64]);
  expect(flag.stderr).toContain("tinker-loop status does not take --open");
});
