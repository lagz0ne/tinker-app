import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, onTestFinished, test } from "vite-plus/test";

import { git } from "@/resources/git";
import { appDir, childEnv } from "@/tags";

import { tempFolder } from "./temp";

const env = { PATH: process.env.PATH };

/** A temp git repo with one commit and an app folder at apps/one. */
function repo() {
  const top = tempFolder();
  mkdirSync(join(top, "apps/one"), { recursive: true });
  writeFileSync(join(top, "apps/one/readme.md"), "");

  const run = (...args: string[]) => execFileSync("git", args, { cwd: top, encoding: "utf8" });
  run("init", "--quiet");
  run("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "one");
  return { top, head: run("rev-parse", "HEAD").trim() };
}

test("git answers in appDir: HEAD, a ref, history, the app's path in the repo, and the top", async () => {
  const { top, head } = repo();
  const scope = createScope({ tags: [appDir(join(top, "apps/one")), childEnv(env)] });
  const answers = scope.resolve(git);

  const found = {
    head: answers.headSha(),
    ref: answers.commitSha("no-such-ref"),
    history: [answers.inHistory(head, head), answers.inHistory("no-such-ref", head)],
    scope: answers.appScope(),
    top: answers.top(),
    raw: answers.run(["show", "-s", "--format=%s"], { raw: true }),
  };
  await scope.close();

  expect(found).toEqual({
    head,
    ref: null,
    history: [true, false],
    scope: "apps/one",
    top,
    raw: "one\n",
  });
});

test("outside a repo git answers null, and the app's path is the folder itself", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir), childEnv(env)] });
  const answers = scope.resolve(git);

  const found = [answers.headSha(), answers.top(), answers.appScope()];
  await scope.close();

  expect(found).toEqual([null, null, dir]);
});

test("git sees only childEnv: a GIT_DIR in the tool's env does not reach it", async () => {
  const { top, head } = repo();
  process.env.GIT_DIR = "/no/such/git/dir";
  onTestFinished(() => {
    delete process.env.GIT_DIR;
  });
  const scope = createScope({ tags: [appDir(top), childEnv(env)] });
  const answers = scope.resolve(git);

  const found = answers.headSha();
  await scope.close();

  expect(found).toBe(head);
});

test("tree() lists untracked files, says if the app is dirty, and fingerprints its uncommitted work", async () => {
  const { top } = repo();
  const scope = createScope({ tags: [appDir(top), childEnv(env)] });
  const answers = scope.resolve(git);

  const clean = answers.tree();
  writeFileSync(join(top, "new.txt"), "one");
  const added = answers.tree();
  writeFileSync(join(top, "new.txt"), "two");
  const edited = answers.tree();
  writeFileSync(join(top, "new.txt"), "one");
  const back = answers.tree();
  await scope.close();

  expect([clean.untracked, clean.dirty]).toEqual([[], false]);
  expect([added.untracked, added.dirty]).toEqual([["new.txt"], true]);
  expect(new Set([clean.fingerprint, added.fingerprint, edited.fingerprint]).size).toBe(3);
  expect(back.fingerprint).toBe(added.fingerprint);
});

test("outside a repo tree() has no untracked list and no fingerprint", async () => {
  const scope = createScope({ tags: [appDir(tempFolder()), childEnv(env)] });

  const tree = scope.resolve(git).tree();
  await scope.close();

  expect(tree).toEqual({ untracked: null, dirty: false, fingerprint: null });
});
