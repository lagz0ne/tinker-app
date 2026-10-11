import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const hooks = join(root, "../tinkered/.vite-hooks/_");
const ref = process.env.REGISTRY_HOOK_REF ?? "HEAD";
const readme = "apps/start-scaffold/README.md";

const repair =
  "Registry index check failed. Fix: pnpm --dir apps/start-scaffold run registry:build";

/** Use real commits and the shared hook without changing shared Git config. */
await test("the commit hook checks the staged registry", async (t) => {
  const scratch =
    process.env.REGISTRY_HOOK_SCRATCH ?? (await mkdtemp(join(tmpdir(), "registry-hook-")));
  const env = { ...process.env, TINKER_SETUP: "0" };
  function run(command, args, cwd = scratch) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
    return { status: result.status, output: result.stdout + result.stderr, stderr: result.stderr };
  }
  function ok(command, args, cwd) {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, result.output);
    return result.output;
  }
  function commit(paths) {
    ok("git", ["add", "--", ...paths]);
    return run("git", [
      "-c",
      `core.hooksPath=${hooks}`,
      "commit",
      "-m",
      "test: registry hook proof",
      "--",
      ...paths,
    ]);
  }
  function rejected(result) {
    assert.notEqual(result.status, 0, result.output);
    assert.ok(result.output.includes(repair), result.output);
    console.log(result.output);
  }
  function passed(result, checked = true) {
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.output.includes("node apps/start-scaffold/maintain/check-registry-staged.mjs"),
      checked,
      result.output,
    );
    console.log(result.output);
  }
  ok("git", ["worktree", "add", "--detach", scratch, ref], root);
  try {
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    await symlink(
      join(root, "apps/start-scaffold/node_modules"),
      join(scratch, "apps/start-scaffold/node_modules"),
      "dir",
    );
    await cp(
      join(root, "apps/start-scaffold/.tinker"),
      join(scratch, "apps/start-scaffold/.tinker"),
      { recursive: true },
    );
    if (process.env.REGISTRY_HOOK_WORKING) {
      const paths = [
        "vite.config.ts",
        "apps/start-scaffold/maintain/check-registry-index.mjs",
        "apps/start-scaffold/maintain/check-registry-staged.mjs",
        "apps/start-scaffold/maintain/check-registry.mjs",
      ];
      for (const path of paths) await cp(join(root, path), join(scratch, path));
      passed(commit(paths));
    }
    const base = ok("git", ["rev-parse", "HEAD"]).trim();
    async function scenario(name, body) {
      await t.test(name, async () => {
        ok("git", ["reset", "--hard", base]);
        await body();
      });
    }
    await scenario("a: stale staged index fails with the repair line", async () => {
      await appendFile(join(scratch, readme), "\nHook proof.\n");
      rejected(commit([readme]));
    });
    await scenario("b: rebuilt disk files do not hide a stale staged index", async () => {
      await appendFile(join(scratch, readme), "\nHook proof.\n");
      ok("pnpm", ["--dir", "apps/start-scaffold", "run", "registry:build"]);
      rejected(commit([readme]));
    });
    await scenario("c: unstaged source changes do not fail another scaffold commit", async () => {
      await appendFile(join(scratch, readme), "\nHook proof.\n");
      const path = "apps/start-scaffold/maintain/check-compose.mjs";
      await appendFile(join(scratch, path), "\n// Hook proof.\n");
      passed(commit([path]));
    });
    await scenario("d: a commit outside registry inputs skips the check", async () => {
      await appendFile(join(scratch, "README.md"), "\nHook proof.\n");
      passed(commit(["README.md"]), false);
    });
    await scenario("e: rebuilding and staging the generated files passes once", async () => {
      await appendFile(join(scratch, readme), "\nHook proof.\n");
      ok("pnpm", ["--dir", "apps/start-scaffold", "run", "registry:build"]);
      const result = commit([readme, "apps/start-scaffold/public/r"]);
      passed(result);
      assert.equal(
        result.output.match(
          /(?:⋯|\[STARTED\]) node apps\/start-scaffold\/maintain\/check-registry-staged\.mjs/g,
        )?.length,
        1,
        result.output,
      );
    });
    await scenario("a missing staged index fails with the repair line first", async () => {
      const path = "apps/start-scaffold/public/r/registry.json";
      await rm(join(scratch, path));
      ok("git", ["add", path]);
      const direct = run("node", ["apps/start-scaffold/maintain/check-registry-staged.mjs"]);
      assert.equal(direct.status, 1, direct.output);
      assert.equal(direct.stderr.split("\n")[0], repair, direct.output);
      ok("git", ["restore", "--staged", path]);
      const trigger = "apps/start-scaffold/maintain/check-compose.mjs";
      await appendFile(join(scratch, trigger), "\n// Hook proof.\n");
      rejected(commit([path, trigger]));
    });
    for (const path of [
      "apps/start-min/src/backend/greet.ts",
      "packages/start/package.json",
      "packages/start/lib/release.mjs",
      "pnpm-workspace.yaml",
    ]) {
      await scenario(`outside scaffold: ${path} triggers the check`, async () => {
        if (path.endsWith("package.json")) {
          const pkg = JSON.parse(await readFile(join(scratch, path), "utf8"));
          pkg.version = "0.6.1";
          await writeFile(join(scratch, path), JSON.stringify(pkg, null, 2) + "\n");
        } else if (path.endsWith("release.mjs")) {
          await writeFile(
            join(scratch, path),
            (await readFile(join(scratch, path), "utf8")).replace(
              '"https://github.com"',
              '"https://example.com"',
            ),
          );
        } else if (path.endsWith(".yaml")) {
          await writeFile(
            join(scratch, path),
            (await readFile(join(scratch, path), "utf8")).replace(
              "react: ^19.3.0",
              "react: ^19.3.1",
            ),
          );
        } else {
          await appendFile(join(scratch, path), "\n// Hook proof.\n");
        }
        rejected(commit([path]));
      });
    }
    await scenario("f: test:registry fails on drift and keeps the clean PASS lines", async () => {
      await appendFile(join(scratch, readme), "\nHook proof.\n");
      const drift = run("pnpm", ["--dir", "apps/start-scaffold", "run", "test:registry"]);
      assert.equal(drift.status, 1, drift.output);
      assert.match(drift.output, /registry index must match source too/);
      ok("git", ["restore", readme]);
      const clean = ok("pnpm", ["--dir", "apps/start-scaffold", "run", "test:registry"]);
      for (const composition of ["app", "app + mail-example", "app + starter"])
        assert.ok(clean.includes(`PASS: ${composition} composition build EXIT 0.`), clean);
      assert.match(clean, /PASS: 10 registry items; 96 emitted files match source\. No publish\./);
      console.log(`drift EXIT ${drift.status}\n${clean}`);
    });
  } finally {
    ok("git", ["worktree", "remove", "--force", scratch], root);
    await rm(scratch, { recursive: true, force: true });
  }
});
