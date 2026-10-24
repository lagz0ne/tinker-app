import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { scan } from "@/resources/scan";
import { appDir, childEnv } from "@/tags";

import { tempFolder } from "./temp";

const env = { PATH: process.env.PATH };

/**
 * A git repo on branch main with one commit, then a branch work.
 * @param files - From a test; why: the first commit's files.
 */
function repo(files: Record<string, string> = { "readme.md": "" }) {
  const app = tempFolder();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: app,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet", "-b", "main");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(app, file), text);
  git("add", ".");
  git("commit", "--quiet", "-m", "one");

  git("checkout", "--quiet", "-b", "work");
  return { app, git };
}

/** @param app - From repo; why: the app to scan. */
function scanner(app: string) {
  const scope = createScope({ tags: [appDir(app), childEnv(env)] });
  return { found: scope.resolve(scan), close: () => scope.close() };
}

test("the base is --base when it names a commit, else loop.json's branch, its upstream, or the one remote's", async () => {
  const upstream = repo();
  const { app, git } = repo();
  git("remote", "add", "origin", upstream.app);
  git("fetch", "--quiet", "origin");
  const { found, close } = scanner(app);

  const bases = [
    found.base({ wanted: "main", configured: "nope" }),
    found.base({ wanted: "nope", configured: "main" }),
    found.base({ wanted: null, configured: null }),
    found.base({ wanted: null, configured: "main" }),
    found.base({ wanted: null, configured: "work" }),
  ];
  git("branch", "--quiet", "--set-upstream-to=origin/main", "main");
  const tracked = found.base({ wanted: null, configured: "main" });
  git("branch", "--quiet", "-D", "main");
  const remote = found.base({ wanted: null, configured: "main" });
  git("remote", "add", "other", upstream.app);
  const twoRemotes = found.base({ wanted: null, configured: "main" });
  await close();

  expect(bases).toEqual(["main", null, null, "main", "work"]);
  expect([tracked, remote, twoRemotes]).toEqual(["origin/main", "origin/main", null]);
});

test("the diff runs from where the branch left the base, and adds each untracked file", async () => {
  const { app, git } = repo({ "a.ts": "one\n" });
  writeFileSync(join(app, "a.ts"), "one\ntwo\n");
  git("commit", "--quiet", "-am", "two");
  writeFileSync(join(app, "new.ts"), "x\ny\n");
  writeFileSync(join(app, "binary.bin"), "a\0b");
  writeFileSync(join(app, "large.txt"), "x".repeat(1024 * 1024 + 1));
  symlinkSync("a.ts", join(app, "link.ts"));
  mkdirSync(join(app, "dir"));
  const { found, close } = scanner(app);

  const diff = found.diff("main", [
    "new.ts",
    "binary.bin",
    "large.txt",
    "link.ts",
    "gone.ts",
    "dir",
  ]);
  const none = [found.diff("main", null), found.diff("no-such-base", [])];
  await close();

  expect(diff).toContain("+two");
  expect(diff).toContain("diff --git a/new.ts b/new.ts\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+x\n+y");
  expect(diff).not.toContain("binary.bin");
  expect(diff).not.toContain("large.txt");
  expect(diff).not.toContain("link.ts");
  expect(none).toEqual([null, null]);
});

test("hits are question findings on added lines, once per id, with the file and new line", async () => {
  const { app } = repo();
  const { found, close } = scanner(app);
  const long = `Date.now(); ${"x".repeat(150)}`;
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +3,4 @@",
    "+const t = Date.now();",
    "+ok();",
    `+${long}`,
    "+const t = Date.now();",
    "-Math.random();",
    "diff --git a/b c.ts b/b c.ts",
    "+++ b/b c.ts\t",
    "@@ -0,0 +1 @@",
    "+++process.env.X;",
  ].join("\n");

  const hits = found.hits(diff);
  await close();

  expect(hits.map(({ rule, file, line, summary }) => ({ rule, file, line, summary }))).toEqual([
    { rule: "B3", file: "src/a.ts", line: 3, summary: "clock or random: const t = Date.now();" },
    { rule: "B3", file: "src/a.ts", line: 5, summary: `clock or random: ${long.slice(0, 117)}...` },
    { rule: "B1", file: "b c.ts", line: 1, summary: "process global: ++process.env.X;" },
  ]);
  expect(hits[0]).toMatchObject({
    severity: "question",
    source: "check",
    fix: "Use the unit's clock and random.",
    trigger: "Quick-scan grep hit on an added line. Read the code before you call it a problem.",
  });
  expect(hits[0].id).toMatch(/^[0-9a-f]{12}$/);
});
