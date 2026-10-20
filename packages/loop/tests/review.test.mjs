import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { main } from "../lib/main.mjs";
import { promptTitle } from "../lib/review.mjs";
import { commit, findingsOf, git, loop, pass, repo, setFindings, tempFolder } from "./fixture.mjs";

const fake = fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url));
const bin = fileURLToPath(new URL("../bin/tinker-loop.mjs", import.meta.url));
const skill = "---\nname: tinker-review\n---\n\n# Review a change\n\nSKILL TEXT: the rules.\n";

/**
 * A repo on branch `work`, one commit past `main`, with the review skill and a loop.json
 * whose reviewer is the fake one.
 * @param {object | null} [review] - From a test; why: the loop.json review block; null for none.
 */
function reviewApp(review = { command: ["node", fake, "{prompt}"] }) {
  const config = {
    base: "main",
    gates: [{ name: "ok", run: pass }],
    ...(review ? { review } : {}),
  };
  const app = repo({
    "loop.json": JSON.stringify(config),
    ".agents/skills/tinker-review/SKILL.md": skill,
  });

  git(app, "checkout", "--quiet", "-b", "work");
  commit(app, { "src/a.ts": "export const a = 1;\n" }, "change");
  mkdirSync(join(app, ".loop"), { recursive: true });
  return app;
}

/**
 * @param {string} app - From a test; why: where the fake reviewer reads its reply.
 * @param {(string | object)[]} lines - From a test; why: the report, objects as JSON lines.
 */
function reply(app, lines) {
  const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
  writeFileSync(join(app, ".loop/reply.txt"), `${text.join("\n")}\n`);
}

/** @param {string} app - From a test; why: what the fake reviewer was called with. */
function called(app) {
  return JSON.parse(readFileSync(join(app, ".loop/argv.json"), "utf8"));
}

/** @param {string} app - From a test; why: the recorded review rounds. */
function rounds(app) {
  const path = join(app, ".loop/rounds.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

const finding = (rule, file, summary) => ({
  id: "slug",
  rule,
  severity: "important",
  file,
  line: 3,
  summary,
  trigger: "the path that breaks",
  fix: "one sentence",
});

test("review runs the reviewer on the change and adds its findings as one review round", async () => {
  const app = reviewApp();
  const head = git(app, "rev-parse", "HEAD");
  reply(app, [finding("C3", "src/a.ts", "a write opens its own session")]);

  const run = await loop(app, "review");

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("tinker-loop review, round 1: 1 reported, 0 rechecked fixed\n");
  expect(findingsOf(app)).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      rule: "C3",
      severity: "important",
      file: "src/a.ts",
      line: 3,
      summary: "a write opens its own session",
      trigger: "the path that breaks",
      fix: "one sentence",
      source: "review",
      seenSha: head,
      round: 1,
      status: "open",
    },
  ]);
  expect(rounds(app)).toEqual([{ round: 1, source: "review", sha: head }]);
  expect(called(app).stdin).toBe(0);
});

test("the prompt holds the skill, the range, the new files, and the open findings", async () => {
  const app = reviewApp();
  const start = git(app, "rev-parse", "main");
  reply(app, [finding("C3", "src/a.ts", "a write opens its own session")]);
  await loop(app, "review");
  const [open] = findingsOf(app);
  writeFileSync(join(app, "src/new.ts"), "export const b = 2;\n");

  await loop(app, "review");
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");

  expect(called(app).argv).toEqual([prompt]);
  expect(prompt.startsWith(`${promptTitle}\n\n${skill.trimEnd()}`)).toBe(true);
  expect(prompt).toContain(`The change starts at ${start}, where this branch left main.`);
  expect(prompt).toContain("Read the change in .loop/review/change.patch");
  expect(prompt).toContain("1 new files not yet in git are listed in .loop/review/untracked.txt");
  expect(prompt).toContain("You can use Read, Grep, and Glob. You cannot run commands.");
  expect(readFileSync(join(app, ".loop/review/change.patch"), "utf8")).toBe(
    git(app, "diff", "--no-color", "--relative", start) + "\n",
  );
  expect(readFileSync(join(app, ".loop/review/untracked.txt"), "utf8")).toBe("src/new.ts\n");
  expect(prompt).toContain(`{"id":"${open.id}","rule":"C3"`);
  expect(prompt).toContain('If it is fixed, print only {"id": "<its id>", "status": "fixed"}.');
  expect(prompt).toContain("Print only JSON lines");
  expect(prompt).toContain("do not report G1");
});

test("a line that is not a finding becomes one question row naming it", async () => {
  const app = reviewApp();
  reply(app, [
    "```json",
    finding("C3", "src/a.ts", "a write opens its own session"),
    "",
    "not json at all",
    '{"rule":"C3"}',
    '{"id":"nope","status":"fixed"}',
    "[1, 2]",
    { ...finding("C3", "src/a.ts", "bad"), severity: "major" },
    "```",
    "clear",
  ]);

  const run = await loop(app, "review");
  const questions = findingsOf(app).filter((row) => row.rule === "review-output");

  expect(run.code).toBe(0);
  expect(findingsOf(app).filter((row) => row.rule === "C3")).toHaveLength(1);
  expect(
    questions.map(({ severity, file, line, summary, trigger }) => [
      severity,
      file,
      line,
      summary,
      trigger,
    ]),
  ).toEqual([
    [
      "question",
      ".loop/review/output.txt",
      4,
      "the reviewer printed a line that is not a finding: not json at all",
      "Line 4 of the reviewer's output: it is not JSON.",
    ],
    [
      "question",
      ".loop/review/output.txt",
      5,
      'the reviewer printed a line that is not a finding: {"rule":"C3"}',
      `Line 5 of the reviewer's output: "severity" must be one of important, question, nit, old.`,
    ],
    [
      "question",
      ".loop/review/output.txt",
      6,
      'the reviewer printed a line that is not a finding: {"id":"nope","status":"fixed"}',
      "Line 6 of the reviewer's output: it marks a finding fixed that was not sent for recheck.",
    ],
    [
      "question",
      ".loop/review/output.txt",
      7,
      "the reviewer printed a line that is not a finding: [1, 2]",
      "Line 7 of the reviewer's output: it is not a JSON object.",
    ],
    [
      "question",
      ".loop/review/output.txt",
      8,
      expect.stringContaining('"severity":"major"'),
      `Line 8 of the reviewer's output: "severity" must be one of important, question, nit, old.`,
    ],
  ]);
});

test("recheck: a reported id stays open, a fixed one is fixed, an unmentioned one stays open", async () => {
  const app = reviewApp();
  reply(app, [
    finding("C3", "src/a.ts", "first"),
    finding("C4", "src/a.ts", "second"),
    finding("H3", "src/a.ts", "third"),
  ]);
  await loop(app, "review");
  const [first, second, third] = findingsOf(app);
  const head = commit(app, { "src/a.ts": "export const a = 2;\n" }, "fix one");
  reply(app, [
    { ...finding("C3", "src/a.ts", "first, said again in other words"), id: first.id },
    { id: second.id, status: "fixed" },
  ]);

  const run = await loop(app, "review");
  const rows = Object.fromEntries(findingsOf(app).map((row) => [row.id, row]));

  expect(run.stdout).toContain("round 2: 1 reported, 1 rechecked fixed");
  expect(findingsOf(app)).toHaveLength(3);
  expect(rows[first.id]).toEqual(
    expect.objectContaining({
      status: "open",
      round: 2,
      seenSha: head,
      summary: "first, said again in other words",
    }),
  );
  expect(rows[second.id]).toEqual(
    expect.objectContaining({ status: "fixed", round: 2, sha: head }),
  );
  expect(rows[third.id]).toEqual(third);
  expect(rounds(app).map((r) => r.round)).toEqual([1, 2]);
});

test("a reported finding keeps an answer, and opens again after a fix by hand", async () => {
  const app = reviewApp();
  const line = finding("C3", "src/a.ts", "a write opens its own session");
  reply(app, [line]);
  await loop(app, "review");
  const [row] = findingsOf(app);
  await loop(app, "answer", row.id, "--reason", "the old profile write keeps its transaction");

  await loop(app, "review");
  const answered = findingsOf(app)[0];
  commit(app, { "src/a.ts": "export const a = 3;\n" }, "try a fix");
  await loop(app, "answer", row.id, "--fixed");
  await loop(app, "review");

  expect(answered).toEqual(expect.objectContaining({ id: row.id, status: "answered", round: 2 }));
  expect(findingsOf(app)[0]).toEqual(
    expect.objectContaining({ id: row.id, status: "open", round: 3 }),
  );
  expect(findingsOf(app)[0]).not.toHaveProperty("sha");
});

test("a failing reviewer exits 1 and writes nothing", async () => {
  const app = reviewApp();
  reply(app, ["exit 3"]);
  setFindings(app, [{ id: "keep", rule: "C3", source: "review", round: 1, status: "open" }]);

  const run = await loop(app, "review");

  expect(run.code).toBe(1);
  expect(run.stderr).toBe(
    "tinker-loop review: the reviewer exited with code 3; see .loop/review/stderr.log\n",
  );
  expect(readFileSync(join(app, ".loop/review/stderr.log"), "utf8")).toBe(
    "the fake reviewer failed\n",
  );
  expect(findingsOf(app)).toEqual([
    { id: "keep", rule: "C3", source: "review", round: 1, status: "open" },
  ]);
  expect(rounds(app)).toEqual([]);
});

test("a reviewer past its timeout is killed with its process group and exits 1", async () => {
  const app = reviewApp({ command: ["node", fake], timeout: 1000 });
  reply(app, ["sleep"]);

  const run = await loop(app, "review");
  const pid = Number(readFileSync(join(app, ".loop/sleeper.pid"), "utf8"));

  expect(run.code).toBe(1);
  expect(run.stderr).toContain("the reviewer timed out after 1000 ms");
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  expect(rounds(app)).toEqual([]);
});

test("a stop kills the reviewer, writes nothing, and exits 130", async () => {
  const app = reviewApp();
  reply(app, ["sleep"]);
  const stop = new AbortController();
  setTimeout(() => stop.abort("SIGINT"), 500);

  const code = await main({
    args: ["review"],
    cwd: app,
    stdout: { write: () => true },
    stderr: { write: () => true },
    signal: stop.signal,
  });

  expect(code).toBe(130);
  expect(existsSync(join(app, ".loop/findings.jsonl"))).toBe(false);
  expect(rounds(app)).toEqual([]);
});

test("the default reviewer is Claude Opus 5.5, restricted to Read, Grep, and Glob, prompt on stdin", () => {
  const app = reviewApp(null);
  const tools = tempFolder({});
  writeFileSync(join(tools, "claude"), `#!/bin/sh\nexec node ${fake} "$@"\n`);
  chmodSync(join(tools, "claude"), 0o755);
  reply(app, []);

  const run = spawnSync(process.execPath, [bin, "review"], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}` },
  });
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");

  expect(run.status).toBe(0);
  expect(called(app).argv).toEqual([
    "-p",
    "--model",
    "claude-opus-5-5",
    "--restricted",
    "--tools",
    "Read,Grep,Glob",
    "--allowedTools",
    "Read,Grep,Glob",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--no-session-persistence",
  ]);
  expect(called(app).argv.join(" ")).not.toContain("Bash");
  expect(readFileSync(join(app, ".loop/stdin.txt"), "utf8")).toBe(prompt);
  expect(prompt.startsWith("-")).toBe(false);
});

test("a big change keeps the prompt small: the file list goes to untracked.txt", () => {
  const app = reviewApp(null);
  const tools = tempFolder({});
  writeFileSync(join(tools, "claude"), `#!/bin/sh\nexec node ${fake} "$@"\n`);
  chmodSync(join(tools, "claude"), 0o755);
  mkdirSync(join(app, "src/many"), { recursive: true });
  const names = Array.from(
    { length: 3000 },
    (_, n) => `src/many/file-${String(n).padStart(4, "0")}-${"x".repeat(40)}.ts`,
  );
  for (const name of names) writeFileSync(join(app, name), "export {};\n");
  reply(app, []);

  const run = spawnSync(process.execPath, [bin, "review"], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}` },
  });
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");
  const listed = readFileSync(join(app, ".loop/review/untracked.txt"), "utf8").trim().split("\n");

  expect(run.status).toBe(0);
  expect(names.join("\n").length).toBeGreaterThan(128 * 1024);
  expect(Buffer.byteLength(prompt)).toBeLessThan(16 * 1024);
  expect(listed.toSorted()).toEqual(names.toSorted());
  expect(called(app).argv.every((word) => word.length < 1024)).toBe(true);
});

test("an answered finding is in the prompt, and a reworded repeat updates it", async () => {
  const app = reviewApp();
  reply(app, [finding("C3", "src/a.ts", "a write opens its own session")]);
  await loop(app, "review");
  const [row] = findingsOf(app);
  await loop(app, "answer", row.id, "--reason", "the old profile write keeps its transaction");
  reply(app, [
    { ...finding("C3", "src/a.ts", "the write opens a session of its own"), id: row.id },
  ]);

  await loop(app, "review");
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");

  expect(prompt).toContain(
    JSON.stringify({
      id: row.id,
      rule: "C3",
      severity: "important",
      file: "src/a.ts",
      line: 3,
      summary: "a write opens its own session",
      reason: "the old profile write keeps its transaction",
    }),
  );
  expect(findingsOf(app)).toEqual([
    expect.objectContaining({
      id: row.id,
      status: "answered",
      summary: "the write opens a session of its own",
      reason: "the old profile write keeps its transaction",
      round: 2,
    }),
  ]);
});

test("review-output rows are not sent back for recheck or as answered", async () => {
  const app = reviewApp();
  reply(app, ["not a finding"]);
  await loop(app, "review");
  const [question] = findingsOf(app);
  reply(app, []);

  await loop(app, "review");
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");

  expect(question.rule).toBe("review-output");
  expect(prompt).not.toContain(question.id);
  expect(prompt).toContain("None: this is the first review, or all earlier findings are closed.");
});

test("a G1 line from the reviewer is not a finding: gates belong to check", async () => {
  const app = reviewApp();
  reply(app, [finding("G1", "typecheck", "the typecheck gate is red")]);

  await loop(app, "review");
  const rows = findingsOf(app);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(
    expect.objectContaining({
      rule: "review-output",
      severity: "question",
      trigger:
        'Line 1 of the reviewer\'s output: "G1" belongs to tinker-loop check; the reviewer does not report gates.',
    }),
  );
});

test("review exits 78 with no skill, a bad review block, or no base; 64 for an unknown --base", async () => {
  const noSkill = repo({
    "loop.json": JSON.stringify({ base: "main", gates: [{ name: "ok", run: pass }] }),
  });
  const badReview = reviewApp({ command: "node fake.mjs" });
  const badTimeout = reviewApp({ timeout: 0 });
  const noBase = reviewApp();
  writeFileSync(
    join(noBase, "loop.json"),
    JSON.stringify({ gates: [{ name: "ok", run: pass }], review: { command: ["node", fake] } }),
  );

  const runs = {
    skill: await loop(noSkill, "review"),
    command: await loop(badReview, "review"),
    timeout: await loop(badTimeout, "review"),
    base: await loop(noBase, "review"),
    unknown: await loop(noBase, "review", "--base", "nowhere"),
  };

  expect(Object.values(runs).map((run) => run.code)).toEqual([78, 78, 78, 78, 64]);
  expect(runs.skill.stderr).toContain(".agents/skills/tinker-review/SKILL.md is missing");
  expect(runs.command.stderr).toContain('"review.command" must list the program and its arguments');
  expect(runs.timeout.stderr).toContain('"review.timeout" must be a positive whole number');
  expect(runs.base.stderr).toContain(
    'no base found to review from; set "base" in loop.json or pass --base',
  );
  expect(runs.unknown.stderr).toContain("tinker-loop review: git cannot find --base nowhere");
});

test("review takes only --app and --base", async () => {
  const app = reviewApp();

  const ids = await loop(app, "review", "C3");
  const flag = await loop(app, "review", "--open");

  expect([ids.code, flag.code]).toEqual([64, 64]);
  expect(flag.stderr).toContain("tinker-loop review does not take --open");
});
