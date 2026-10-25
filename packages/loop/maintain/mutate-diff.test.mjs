import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

const script = join(import.meta.dirname, "mutate-diff.mjs");

/** A git repo with src/a.ts and src/b.ts committed; returns it and its git runner. */
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-mutate-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  /** @param {string[]} args - From a test; why: the git command line. */
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

  git("init", "--quiet", "-b", "main");
  mkdirSync(join(dir, "src/nested"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(dir, "src/b.ts"), "keep\ngone\n");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");

  return { dir, git, base: git("rev-parse", "HEAD") };
}

/**
 * @param {string} dir - From repo; why: the app folder to plan in.
 * @param {string} base - From repo; why: the commit the change starts at.
 * @param {string} head - From repo; why: the commit the change ends at.
 */
function plan(dir, base, head) {
  return spawnSync(
    process.execPath,
    [script, "--dir", dir, "--base", base, "--head", head, "--plan"],
    { encoding: "utf8" },
  );
}

test("the plan lists each changed src TypeScript range on the new side, and nothing else", () => {
  const { dir, git, base } = repo();
  writeFileSync(join(dir, "src/a.ts"), "one\nTWO\nthree\nfour\nfive\nsix\n");
  writeFileSync(join(dir, "src/b.ts"), "keep\n");
  writeFileSync(join(dir, "src/nested/c.ts"), "new\n");
  writeFileSync(join(dir, "src/notes.md"), "not code\n");
  writeFileSync(join(dir, "README.md"), "changed\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "change");

  const ran = plan(dir, base, git("rev-parse", "HEAD"));

  expect(ran.stderr).toBe("");
  expect(ran.status).toBe(0);
  expect(ran.stdout).toBe("src/a.ts:2-2\nsrc/a.ts:5-6\nsrc/nested/c.ts:1-1\n");
});

test("a change with no src lines to mutate says so and exits 0", () => {
  const { dir, git, base } = repo();
  writeFileSync(join(dir, "README.md"), "changed\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "docs");

  const ran = plan(dir, base, git("rev-parse", "HEAD"));

  expect(ran.status).toBe(0);
  expect(ran.stdout).toBe("mutation: no changed src lines\n");
});

test("a missing --base or --head exits 64 with the usage line", () => {
  const ran = spawnSync(process.execPath, [script, "--base", "x"], { encoding: "utf8" });

  expect(ran.status).toBe(64);
  expect(ran.stderr).toBe(
    "usage: node maintain/mutate-diff.mjs --base <sha> --head <sha> [--dir <app>] [--plan]\n",
  );
});
