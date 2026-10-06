import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { installCommand, notesBetween, pinDependencies, planUpgrade } from "../lib/upgrade.mjs";
import { fixture, installedApp, write } from "./fixture.mjs";

const tested = {
  "@tanstack/react-router": "1.170.41",
  "@tinker/core": "0.0.0",
  "@tinker/react": "0.0.0",
};

test("an upgrade sets the new base and pins each drifted peer to the tested version", () => {
  const { dependencies, changes } = pinDependencies(
    {
      "@tinker/start": "file:packs/tinker-start-0.1.0.tgz",
      "@tanstack/react-router": "1.160.0",
      zod: "^4",
    },
    "file:packs/tinker-start-0.2.0.tgz",
    tested,
    () => null,
  );
  expect(dependencies).toEqual({
    "@tinker/start": "file:packs/tinker-start-0.2.0.tgz",
    "@tanstack/react-router": "1.170.41",
    zod: "^4",
  });
  expect(changes).toEqual([
    ["@tinker/start", "file:packs/tinker-start-0.1.0.tgz", "file:packs/tinker-start-0.2.0.tgz"],
    ["@tanstack/react-router", "1.160.0", "1.170.41"],
  ]);
});

test("workspace, catalog, and tarball specs that install the tested version stay", () => {
  const { changes } = pinDependencies(
    {
      "@tinker/start": "0.1.0",
      "@tanstack/react-router": "catalog:",
      "@tinker/core": "workspace:*",
      "@tinker/react": "file:packs/tinker-react.tgz",
    },
    "0.2.0",
    tested,
    (name) => (name === "@tinker/react" ? "0.0.0" : null),
  );
  expect(changes).toEqual([["@tinker/start", "0.1.0", "0.2.0"]]);
});

const upgradeNotes = [
  "# Upgrade notes for `@tinker/start`",
  "",
  "## 0.3.0",
  "",
  "Third.",
  "",
  "## 0.2.0",
  "",
  "Second.",
  "",
  "## 0.1.10",
  "",
  "Tenth patch.",
  "",
  "## 0.1.1",
  "",
  "First patch.",
  "",
].join("\n");

test("the upgrade notes are the sections after the old version, up to the new one", () => {
  expect(notesBetween(upgradeNotes, "0.1.1", "0.2.0")).toBe(
    "## 0.2.0\n\nSecond.\n\n## 0.1.10\n\nTenth patch.",
  );
  expect(notesBetween(upgradeNotes, "0.2.0", "0.2.0")).toBe("");
});

test("the install runs with the package manager the nearest lockfile names", () => {
  const nested = fixture({ "pnpm-lock.yaml": "", "app/package-lock.json": "{}" });
  expect(installCommand(join(nested, "app"))).toBe("npm");
  const workspace = fixture({ "pnpm-lock.yaml": "", "apps/web/package.json": "{}" });
  expect(installCommand(join(workspace, "apps/web"))).toBe("pnpm");
  expect(installCommand(fixture({ "package.json": "{}" }))).toBe("npm");
});

/**
 * A packed release in the app's packs/ folder, as `tinker upgrade --from packs` reads it.
 * @param {string} root - From a test; why: the app folder.
 * @param {string} version - From a test; why: the release's version.
 */
function packRelease(root, version) {
  const tested = { "@tanstack/react-router": "1.170.41" };
  write(root, {
    "release/package/package.json": JSON.stringify({ version, tinker: { tested } }),
    "packs/.keep": "",
  });
  const tarball = join(root, `packs/tinker-start-${version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", join(root, "release"), "package"]);
}

test("an upgrade plan names each dependency change and the base it leaves, and writes nothing", () => {
  const root = installedApp({
    "@tinker/start": "file:base.tgz",
    "@tanstack/react-router": "1.160.0",
  });
  packRelease(root, "9.1.0");
  const before = readFileSync(join(root, "package.json"), "utf8");
  expect(planUpgrade(root, "9.1.0", { from: "packs", force: false })).toEqual({
    pkg: {
      dependencies: {
        "@tinker/start": "file:packs/tinker-start-9.1.0.tgz",
        "@tanstack/react-router": "1.170.41",
      },
    },
    changes: [
      "package.json: @tinker/start file:base.tgz -> file:packs/tinker-start-9.1.0.tgz",
      "package.json: @tanstack/react-router 1.160.0 -> 1.170.41",
    ],
    before: "9.0.0",
  });
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
});

test("a peer whose spec already installs the tested version keeps its spec", () => {
  const root = installedApp({
    "@tinker/start": "file:base.tgz",
    "@tanstack/react-router": "file:router.tgz",
  });
  write(root, {
    "node_modules/@tanstack/react-router/package.json": JSON.stringify({ version: "1.170.41" }),
  });
  packRelease(root, "9.1.0");
  expect(planUpgrade(root, "9.1.0", { from: "packs", force: false }).changes).toEqual([
    "package.json: @tinker/start file:base.tgz -> file:packs/tinker-start-9.1.0.tgz",
  ]);
});

test("with no release folder, an upgrade names the version and pins no peer", () => {
  const root = installedApp({ "@tinker/start": "9.0.0", "@tanstack/react-router": "1.160.0" });
  expect(planUpgrade(root, "9.1.0", { force: false }).changes).toEqual([
    "package.json: @tinker/start 9.0.0 -> 9.1.0",
  ]);
});

test("an upgrade stops on an edited base file, unless forced, and on a missing release", () => {
  const root = installedApp();
  packRelease(root, "9.1.0");
  write(root, {
    "node_modules/@tinker/start/src/a.ts": "edited",
    "node_modules/@tinker/start/src/b.ts": "edited",
  });
  expect(planUpgrade(root, "9.1.0", { from: "packs", force: false })).toEqual({
    stop: "stop: node_modules/@tinker/start/src/a.ts changed; an install drops base edits, so use an extension point; node_modules/@tinker/start/src/b.ts changed; an install drops base edits, so use an extension point\nRun tinker doctor --fix first, or pass --force.",
  });
  expect(planUpgrade(root, "9.1.0", { from: "packs", force: true }).changes).toEqual([
    "package.json: @tinker/start file:base.tgz -> file:packs/tinker-start-9.1.0.tgz",
  ]);
  expect(planUpgrade(root, "9.2.0", { from: "packs", force: true })).toEqual({
    stop: `stop: ${join(root, "packs/tinker-start-9.2.0.tgz")} does not exist`,
  });
});
