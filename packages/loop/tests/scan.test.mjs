import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

import { commit, findingsOf, git, loop, loopJson, pass, repo } from "./fixture.mjs";

/**
 * A clone of `upstream`, removed when the test ends.
 * @param {string} upstream - From repo; why: the repo to clone.
 */
function clone(upstream) {
  const app = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-clone-")));
  onTestFinished(() => rmSync(app, { recursive: true, force: true }));
  git(app, "clone", "--quiet", upstream, ".");
  return app;
}

test("a loop.json base that tracks a remote scans from the remote, not the old local copy", async () => {
  const upstream = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  const app = clone(upstream);
  commit(upstream, { "src/theirs.ts": "Date.now();\n" }, "theirs");
  git(app, "fetch", "--quiet");
  git(app, "checkout", "--quiet", "-b", "work", "origin/main");
  commit(app, { "src/mine.ts": "Math.random();\n" }, "mine");

  const run = await loop(app, "check");

  expect(run.stdout).toContain("scan base: origin/main\n");
  expect(findingsOf(app).map((finding) => finding.file)).toEqual(["src/mine.ts"]);
});

test("a loop.json base with no local branch is found on the one remote", async () => {
  const upstream = repo({ "loop.json": loopJson({ ok: pass }, "dev") });
  git(upstream, "branch", "dev");
  const app = clone(upstream);
  commit(app, { "src/mine.ts": "Math.random();\n" }, "mine");

  const run = await loop(app, "check");

  expect(run.stdout).toContain("scan base: origin/dev\n");
  expect(findingsOf(app).map((finding) => finding.file)).toEqual(["src/mine.ts"]);
});

test("a base that moved on after the branch left it adds none of its commits", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  git(app, "checkout", "--quiet", "-b", "work");
  commit(app, { "src/mine.ts": "Math.random();\n" }, "mine");
  git(app, "checkout", "--quiet", "main");
  commit(app, { "src/theirs.ts": "Date.now();\n" }, "theirs");
  git(app, "checkout", "--quiet", "work");

  await loop(app, "check");

  expect(findingsOf(app).map((finding) => finding.file)).toEqual(["src/mine.ts"]);
});

test("the scan reads the working tree: changed files and untracked files", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "main"), "src/a.ts": "const a = 1;\n" });
  git(app, "checkout", "--quiet", "-b", "work");
  writeFileSync(join(app, "src/a.ts"), "const a = 1;\nDate.now();\n");
  writeFileSync(join(app, "src/new.ts"), "const b = 2;\nclass Store {}\n");

  await loop(app, "check");

  expect(findingsOf(app).map(({ rule, file, line }) => [rule, file, line])).toEqual([
    ["B3", "src/a.ts", 2],
    ["O1", "src/new.ts", 2],
  ]);
});

test("a fix seen only in the working tree is fixed at HEAD and marked dirty", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  git(app, "checkout", "--quiet", "-b", "work");
  const sha = commit(app, { "src/a.ts": "Date.now();\n" }, "change");
  await loop(app, "check");

  writeFileSync(join(app, "src/a.ts"), "\n");
  await loop(app, "check");
  const [dirty] = findingsOf(app);
  writeFileSync(join(app, "src/a.ts"), "Date.now();\n");
  await loop(app, "check");
  const [again] = findingsOf(app);

  expect(dirty).toEqual(expect.objectContaining({ status: "fixed", sha, dirty: true }));
  expect(again.status).toBe("open");
  expect(again).not.toHaveProperty("dirty");
});

test("file names with a space or other letters come through as they are", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  git(app, "checkout", "--quiet", "-b", "work");
  commit(app, { "src/my file.ts": "Date.now();\n", "src/ü.ts": "Date.now();\n" }, "change");

  await loop(app, "check");

  expect(findingsOf(app).map((finding) => finding.file)).toEqual(["src/my file.ts", "src/ü.ts"]);
});
