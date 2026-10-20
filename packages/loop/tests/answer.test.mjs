import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { commit, fail, findingsOf, git, loop, loopJson, repo, setFindings } from "./fixture.mjs";

/** A repo whose red gate gives one G1 finding, seen at the first commit. */
async function redApp() {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  return { app, finding: findingsOf(app)[0] };
}

/** @param {string} app - From a test; why: the findings file to read as text. */
function fileText(app) {
  return readFileSync(join(app, ".loop/findings.jsonl"), "utf8");
}

test("--reason marks a finding answered, and the row stays in the file", async () => {
  const { app, finding } = await redApp();

  const run = await loop(app, "answer", finding.id, "--reason", "  known flake  ");

  expect(run.code).toBe(0);
  expect(run.stdout).toBe(`answered ${finding.id}: known flake\n`);
  expect(findingsOf(app)).toEqual([{ ...finding, status: "answered", reason: "known flake" }]);
  expect(existsSync(join(app, ".loop/findings.lock"))).toBe(false);
});

test("--reason with no text exits 64 and changes nothing", async () => {
  const { app, finding } = await redApp();
  const before = fileText(app);

  const empty = await loop(app, "answer", finding.id, "--reason", "");
  const blank = await loop(app, "answer", finding.id, "--reason", "   ");

  expect([empty.code, blank.code]).toEqual([64, 64]);
  expect(empty.stderr).toContain("tinker-loop answer: --reason needs text");
  expect(fileText(app)).toBe(before);
});

test("an unknown ID exits 64 and writes nothing", async () => {
  const { app } = await redApp();
  const before = fileText(app);
  const bare = repo({ "readme.md": "" });

  const run = await loop(app, "answer", "nope", "--reason", "why");
  const none = await loop(bare, "answer", "nope", "--reason", "why");

  expect(run.code).toBe(64);
  expect(run.stderr).toContain("no finding has id nope");
  expect(fileText(app)).toBe(before);
  expect(none.code).toBe(64);
  expect(existsSync(join(bare, ".loop/findings.jsonl"))).toBe(false);
});

test("--fixed takes HEAD, but only once a commit comes after the finding", async () => {
  const { app, finding } = await redApp();

  const early = await loop(app, "answer", finding.id, "--fixed");
  const sha = commit(app, { fix: "" }, "fix");
  const run = await loop(app, "answer", finding.id, "--fixed");

  expect(early.code).toBe(64);
  expect(early.stderr).toContain(
    `finding ${finding.id} was seen at ${finding.seenSha.slice(0, 12)}; commit the fix after it`,
  );
  expect(run.code).toBe(0);
  expect(run.stdout).toBe(`fixed ${finding.id} at ${sha.slice(0, 12)}\n`);
  expect(findingsOf(app)).toEqual([{ ...finding, status: "fixed", sha }]);
});

test("--sha names the fix: after the finding, and in HEAD's history", async () => {
  const { app, finding } = await redApp();
  const fix = commit(app, { fix: "" }, "fix");
  commit(app, { later: "" }, "later");
  git(app, "checkout", "--quiet", "-b", "side", fix);
  const side = commit(app, { side: "" }, "side");
  git(app, "checkout", "--quiet", "-");

  const seen = await loop(app, "answer", finding.id, "--fixed", "--sha", finding.seenSha);
  const away = await loop(app, "answer", finding.id, "--fixed", "--sha", side);
  const bad = await loop(app, "answer", finding.id, "--fixed", "--sha", "nope");
  const run = await loop(app, "answer", finding.id, "--fixed", "--sha", fix.slice(0, 8));

  expect([seen.code, away.code, bad.code, run.code]).toEqual([64, 64, 64, 0]);
  expect(seen.stderr).toContain("commit the fix after it");
  expect(away.stderr).toContain(`commit ${side.slice(0, 12)} is not in HEAD's history`);
  expect(bad.stderr).toContain("tinker-loop answer: nope is not a commit");
  expect(findingsOf(app)[0]).toEqual(expect.objectContaining({ status: "fixed", sha: fix }));
});

test("a row with no seenSha takes --fixed only with --sha", async () => {
  const app = repo({ "readme.md": "" });
  const review = { id: "review-1", rule: "C3", severity: "important", source: "review" };
  mkdirSync(join(app, ".loop"));
  setFindings(app, [{ ...review, round: 1, status: "open" }]);
  const head = git(app, "rev-parse", "HEAD");

  const bare = await loop(app, "answer", "review-1", "--fixed");
  const named = await loop(app, "answer", "review-1", "--fixed", "--sha", "HEAD");

  expect(bare.code).toBe(64);
  expect(bare.stderr).toContain(
    "finding review-1 has no seenSha, so no tool recorded where it was seen; name the fix commit with --sha",
  );
  expect(named.code).toBe(0);
  expect(findingsOf(app)[0]).toEqual(expect.objectContaining({ status: "fixed", sha: head }));
});

test("a seenSha lost to an amend asks for a new check, then the fix is taken", async () => {
  const { app, finding } = await redApp();
  git(app, "commit", "--quiet", "--amend", "--allow-empty", "-m", "base, amended");
  commit(app, { fix: "" }, "fix");

  const lost = await loop(app, "answer", finding.id, "--fixed");
  await loop(app, "check");
  const sha = commit(app, { fix: "again" }, "fix again");
  const run = await loop(app, "answer", finding.id, "--fixed");

  expect(lost.code).toBe(64);
  expect(lost.stderr).toContain(
    `finding ${finding.id} was seen at ${finding.seenSha.slice(0, 12)}, which is no longer in HEAD's history (amended or rebased); run tinker-loop check, or the tool that saw it, again`,
  );
  expect(run.code).toBe(0);
  expect(findingsOf(app)[0]).toEqual(expect.objectContaining({ status: "fixed", sha }));
});

test("a --sha ref that starts with a dash is read as a ref, not an option", async () => {
  const { app, finding } = await redApp();
  const fix = commit(app, { fix: "" }, "fix");
  git(app, "update-ref", "refs/heads/-x", "HEAD");

  const run = await loop(app, "answer", finding.id, "--fixed", "--sha=-x");

  expect(run.code).toBe(0);
  expect(findingsOf(app)[0]).toEqual(expect.objectContaining({ status: "fixed", sha: fix }));
});

test("answer takes one ID and one of --fixed or --reason", async () => {
  const { app, finding } = await redApp();

  const runs = await Promise.all([
    loop(app, "answer", finding.id),
    loop(app, "answer", finding.id, "--fixed", "--reason", "both"),
    loop(app, "answer", finding.id, "--reason", "why", "--sha", "HEAD"),
    loop(app, "answer", "--reason", "why"),
    loop(app, "answer", finding.id, "other", "--reason", "why"),
    loop(app, "answer", finding.id, "--open"),
  ]);

  expect(runs.map((run) => run.code)).toEqual([64, 64, 64, 64, 64, 64]);
  expect(runs[0].stderr).toContain("give --fixed or --reason, one of them");
  expect(runs[2].stderr).toContain("--sha goes with --fixed");
  expect(runs[3].stderr).toContain("tinker-loop answer takes one finding ID");
  expect(runs[5].stderr).toContain("tinker-loop answer does not take --open");
});

test("a later check reopens a fixed finding it finds again; an answered one stays answered", async () => {
  const { app, finding } = await redApp();
  commit(app, { fix: "" }, "a fix that did not work");
  await loop(app, "answer", finding.id, "--fixed");
  const fixed = findingsOf(app)[0];

  await loop(app, "check");
  const reopened = findingsOf(app)[0];
  await loop(app, "answer", finding.id, "--reason", "the gate is known red");
  await loop(app, "check");

  expect(fixed.status).toBe("fixed");
  expect(reopened).toEqual(
    expect.objectContaining({
      id: finding.id,
      status: "open",
      seenSha: git(app, "rev-parse", "HEAD"),
    }),
  );
  expect(reopened).not.toHaveProperty("sha");
  expect(findingsOf(app)[0]).toEqual(
    expect.objectContaining({ status: "answered", reason: "the gate is known red" }),
  );
});

test("answer waits for the findings lock and writes after its owner releases it", async () => {
  const { app, finding } = await redApp();
  const lock = join(app, ".loop/findings.lock");
  const released = join(app, "released");
  writeFileSync(lock, "someone else");
  const owner = spawn(
    process.execPath,
    [
      "-e",
      "setTimeout(() => { const fs = require('fs'); fs.rmSync(process.argv[1]); fs.writeFileSync(process.argv[2], ''); }, 500)",
      lock,
      released,
    ],
    { stdio: "ignore" },
  );

  const run = await loop(app, "answer", finding.id, "--reason", "why");
  await new Promise((resolve) =>
    owner.exitCode === null ? owner.once("exit", resolve) : resolve(),
  );

  expect(run.code).toBe(0);
  expect(statSync(join(app, ".loop/findings.jsonl")).mtimeMs).toBeGreaterThanOrEqual(
    statSync(released).mtimeMs,
  );
});
