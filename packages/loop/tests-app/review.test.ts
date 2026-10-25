import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { review } from "@/operations/review";
import { appDir, baseRef, childEnv, print, stop, warn } from "@/tags";

import { start, tempFolder, writeLoop } from "./temp";

const skill = "---\nname: tinker-review\n---\n\n# Review a change\n\nSKILL TEXT.\n";

/** A repo on branch work, one commit past main, with the review skill unless `noSkill`. */
function repo(noSkill = false) {
  const app = tempFolder();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: app,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(app, ".gitignore"), ".loop/\nnode_modules/\nreply.txt\nloop.json\n");
  if (!noSkill) {
    mkdirSync(join(app, ".agents/skills/tinker-review"), { recursive: true });
    writeFileSync(join(app, ".agents/skills/tinker-review/SKILL.md"), skill);
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "one");

  git("checkout", "--quiet", "-b", "work");
  writeFileSync(join(app, "a.ts"), "one\ntwo\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "two");
  writeFileSync(join(app, "new.ts"), "x\n");
  return { app, head: git("rev-parse", "HEAD") };
}

/**
 * Run the review operation with a reviewer that prints `reply`.
 * @param app - From repo; why: the app to review.
 * @param reply - From a test; why: what the fake reviewer prints, or null for a failing one.
 * @param options - From a test; why: --base and loop.json's base.
 */
async function run(
  app: string,
  reply: string | null,
  options: { base?: string; configured?: string | null } = {},
) {
  writeFileSync(join(app, "reply.txt"), reply ?? "");
  const code =
    reply === null
      ? "process.exit(3)"
      : "process.stdout.write(require('fs').readFileSync('reply.txt', 'utf8'))";
  writeLoop(app, {
    gates: [{ name: "ok", run: "true" }],
    base: "configured" in options ? (options.configured ?? null) : "main",
    review: { command: [process.execPath, "-e", code] },
  });
  const out: string[] = [];
  const err: string[] = [];
  const tags = [
    appDir(app),
    childEnv({ PATH: process.env.PATH }),
    baseRef(options.base ?? null),
    print((line) => out.push(line)),
    warn((line) => err.push(line)),
    stop(new AbortController().signal),
  ];
  const scope = createScope({ tags });

  const ran = await Promise.resolve(scope.settle(review));
  await scope.close();
  return { outcome: outcomeOf(ran), out, err };
}

/** @param ran - From settle; why: the outcome, or the failure or cancel as text. */
function outcomeOf(ran: { status: string; value?: unknown; error?: unknown; reason?: unknown }) {
  if (ran.status === "success") return ran.value;
  return String(ran.status === "failed" ? ran.error : ran.reason);
}

/** @param app - From repo; why: the app whose findings to read. */
function findingsOf(app: string) {
  const path = join(app, ".loop/findings.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const finding = (fields: object) =>
  JSON.stringify({
    id: "n1",
    rule: "C3",
    severity: "important",
    file: "a.ts",
    line: 2,
    summary: "leak",
    trigger: "t",
    fix: "f",
    ...fields,
  });

test("review writes the change and the prompt, runs the reviewer, records a round, and merges", async () => {
  const { app, head } = repo();

  const { outcome, out } = await run(app, `${finding({})}\n`);
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");
  const rows = findingsOf(app);

  expect(outcome).toBe("done");
  expect(out.slice(0, 2)).toEqual([
    "reviewed: . only",
    "tinker-loop review, round 1: 1 reported, 0 rechecked fixed",
  ]);
  expect(
    prompt.startsWith("Review one change in this app with the tinker-review skill below.\n\n---"),
  ).toBe(true);
  expect(prompt).toContain(`HEAD is ${head}.`);
  expect(prompt).toContain("1 new files not yet in git are listed in .loop/review/untracked.txt");
  expect(readFileSync(join(app, ".loop/review/change.patch"), "utf8")).toContain("+two");
  expect(readFileSync(join(app, ".loop/review/untracked.txt"), "utf8")).toBe("new.ts\n");
  expect(readFileSync(join(app, ".loop/rounds.jsonl"), "utf8")).toBe(
    `${JSON.stringify({ round: 1, source: "review", sha: head })}\n`,
  );
  expect(rows).toEqual([
    expect.objectContaining({
      rule: "C3",
      source: "review",
      status: "open",
      round: 1,
      seenSha: head,
      line: 2,
    }),
  ]);
  expect(rows[0]?.id).toMatch(/^[0-9a-f]{12}$/);
});

test("a .loop folder with no .gitignore of its own is never part of the change", async () => {
  const { app } = repo();
  writeFileSync(join(app, ".gitignore"), "node_modules/\nreply.txt\nloop.json\n");
  mkdirSync(join(app, ".loop"));
  writeFileSync(join(app, ".loop/notes.txt"), "left by hand\n");

  const { outcome } = await run(app, "");

  expect(outcome).toBe("done");
  expect(readFileSync(join(app, ".loop/review/untracked.txt"), "utf8")).toBe("new.ts\n");
  expect(readFileSync(join(app, ".loop/.gitignore"), "utf8")).toBe("*\n");
});

test("a recheck keeps a known id, marks a rechecked open finding fixed, and leaves the rest", async () => {
  const { app } = repo();
  await run(
    app,
    `${finding({ id: "a", summary: "first" })}\n${finding({ id: "b", summary: "second", file: "new.ts", line: 1 })}\n`,
  );
  const [first, second] = findingsOf(app);

  const { out } = await run(
    app,
    `${finding({ id: first?.id, summary: "first, reworded" })}\n{"id": "${String(second?.id)}", "status": "fixed"}\n`,
  );
  const rows = findingsOf(app);
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");

  expect(out[1]).toBe("tinker-loop review, round 2: 1 reported, 1 rechecked fixed");
  expect(rows.map(({ id, status, summary, round }) => ({ id, status, summary, round }))).toEqual([
    { id: first?.id, status: "open", summary: "first, reworded", round: 2 },
    { id: second?.id, status: "fixed", summary: "second", round: 2 },
  ]);
  expect(prompt).toContain(`{"id":"${String(first?.id)}","rule":"C3"`);
});

test("a line that is not a finding becomes one question row naming it; fences and clear lines are skipped", async () => {
  const { app } = repo();
  const reply = [
    "```json",
    "clear: nothing else",
    "",
    "not json",
    "[1]",
    finding({ rule: "G1" }),
    finding({ severity: "huge" }),
    finding({ line: 99 }),
    '{"id": "x", "status": "fixed"}',
    "```",
  ].join("\n");

  await run(app, reply);
  const rows = findingsOf(app);

  expect(rows.map(({ rule, severity, line }) => ({ rule, severity, line }))).toEqual([
    { rule: "review-output", severity: "question", line: 4 },
    { rule: "review-output", severity: "question", line: 5 },
    { rule: "review-output", severity: "question", line: 6 },
    { rule: "review-output", severity: "question", line: 7 },
    { rule: "C3", severity: "important", line: 0 },
    { rule: "review-output", severity: "question", line: 9 },
  ]);
  expect(rows.map(({ trigger }) => trigger)).toEqual([
    "Line 4 of the reviewer's output: it is not JSON.",
    "Line 5 of the reviewer's output: it is not a JSON object.",
    'Line 6 of the reviewer\'s output: "G1" belongs to tinker-loop check; the reviewer does not report gates.',
    'Line 7 of the reviewer\'s output: "severity" must be one of important, question, nit, old.',
    "t (The reviewer gave line 99; the file has 2 lines.)",
    "Line 9 of the reviewer's output: it marks a finding fixed that was not sent for recheck.",
  ]);
});

test("a failing reviewer, an unknown --base, and no base at all write nothing", async () => {
  const { app } = repo();

  const failed = await run(app, null);
  const unknown = await run(app, "", { base: "nope" });
  const none = await run(app, "", { configured: null });

  expect(failed).toEqual({
    outcome: "failed",
    out: ["reviewed: . only"],
    err: ["tinker-loop review: the reviewer exited with code 3; see .loop/review/stderr.log"],
  });
  expect(unknown).toEqual({
    outcome: "refused",
    out: [],
    err: ["tinker-loop review: git cannot find --base nope"],
  });
  expect(none.outcome).toContain(
    'no base found to review from; set "base" in loop.json or pass --base',
  );
  expect(findingsOf(app)).toEqual([]);
});

test("with no review skill the reviewer gets the Start rules; with neither, review says so", async () => {
  const { app } = repo(true);
  const missing = await run(app, "");
  const folder = start(app, "2.0.0", "### C: close\n\n- `C3` Close it.\n");

  const { out } = await run(app, "");
  const prompt = readFileSync(join(app, ".loop/review/prompt.md"), "utf8");

  expect(missing.outcome).toContain(
    `${join(app, ".agents/skills/tinker-review/SKILL.md")} is missing, and the Start rules cannot be read (cannot find @tinker/start from ${app}; install it to read its rules); review needs one of them`,
  );
  expect(out[0]).toBe(
    "review: no tinker-review skill in this app; using @tinker/start 2.0.0 docs/rules.md",
  );
  expect(prompt).toContain(
    "This app has no tinker-review skill, so these are the review rules of its Start.",
  );
  expect(prompt).toContain("- `C3` Close it.");
  expect(folder).toBe(join(app, "node_modules/@tinker/start"));
});

test("a stop while review waits for another tool's lock records no round and writes nothing", async () => {
  const { app } = repo();
  mkdirSync(join(app, ".loop"), { recursive: true });
  const lock = join(app, ".loop/findings.lock");
  writeFileSync(lock, "tool A");
  writeFileSync(join(app, "reply.txt"), `${finding({})}\n`);
  writeLoop(app, {
    gates: [{ name: "ok", run: "true" }],
    base: "main",
    review: {
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(require('fs').readFileSync('reply.txt', 'utf8'))",
      ],
    },
  });
  const halt = new AbortController();
  const tags = [
    appDir(app),
    childEnv({ PATH: process.env.PATH }),
    print(() => {}),
    warn(() => {}),
    stop(halt.signal),
  ];
  const scope = createScope({ tags });

  const waiting = Promise.resolve(scope.run(review));
  while (!existsSync(join(app, ".loop/review/output.txt"))) await delay(20);
  await delay(300);
  halt.abort("SIGINT");
  rmSync(lock);
  const outcome = await waiting;
  await scope.close();

  expect(outcome).toBe("stopped");
  expect(existsSync(join(app, ".loop/rounds.jsonl"))).toBe(false);
  expect(existsSync(join(app, ".loop/findings.jsonl"))).toBe(false);
});
