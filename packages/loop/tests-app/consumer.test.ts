import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempFolder } from "./temp";

const root = join(import.meta.dirname, "..");

/** Run pnpm in a folder; the output joins stdout and stderr, so a failure names its cause. */
function pnpm(dir: string, args: string[]) {
  const run = spawnSync("pnpm", args, { cwd: dir, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test("an app that installs the packed loop with pnpm gets a working tinker-loop", () => {
  const dir = tempFolder();
  const packs = join(dir, "packs");
  const user = join(dir, "user");
  mkdirSync(user);

  // The global setup built dist-cli; packing with no scripts keeps it while other tests run it.
  const pack = pnpm(root, ["pack", "--ignore-scripts", "--pack-destination", packs]);
  expect(pack.output, "pnpm pack").toContain("dist-cli/cli.js");
  const tarball = join(packs, readdirSync(packs)[0] ?? "");

  // The loop's dependencies link to this workspace's copies, so the install needs no network.
  const linked = (name: string) => `link:${realpathSync(join(root, "node_modules", name))}`;
  writeFileSync(
    join(user, "package.json"),
    JSON.stringify({
      name: "user",
      private: true,
      dependencies: { "@tinker/loop": `file:${tarball}` },
    }),
  );
  writeFileSync(
    join(user, "pnpm-workspace.yaml"),
    [
      "overrides:",
      ...["@tinker/start", "@tinker/core", "zod"].map((name) => `  "${name}": "${linked(name)}"`),
      "",
    ].join("\n"),
  );

  const install = pnpm(user, ["install", "--offline", "--store-dir", join(dir, "store")]);
  expect(install.output, "pnpm install").not.toContain("ERR_PNPM");
  expect(install.status, install.output).toBe(0);

  const usage = spawnSync(
    process.execPath,
    [join(user, "node_modules/@tinker/loop/bin/tinker-loop.mjs")],
    { cwd: user, encoding: "utf8" },
  );
  expect(usage.stdout).toBe("");
  expect(usage.stderr).toMatch(/^usage: tinker-loop check/);
  expect(usage.status).toBe(64);
}, 120_000);
