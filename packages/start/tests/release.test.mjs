import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { releaseUrls } from "../lib/release.mjs";

test("release URLs name Start under tinker-app and Core/React under tinkered 0.8.0", () => {
  expect(releaseUrls("0.7.0")).toEqual({
    "@tinker/core":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-core-0.8.0.tgz",
    "@tinker/react":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-react-0.8.0.tgz",
    "@tinker/start":
      "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.7.0/tinker-start-0.7.0.tgz",
  });
});

test("the apps install the same Core and React the release names", () => {
  const root = new URL("../../../", import.meta.url);
  const urls = releaseUrls("0.7.0");
  for (const path of [
    "apps/start-min/package.json",
    "apps/start-scaffold/package.json",
    "apps/start-scaffold/app.package.json",
    "packages/start/package.json",
  ]) {
    const pkg = JSON.parse(readFileSync(new URL(path, root), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["@tinker/core", "@tinker/react"]) expect(deps[name]).toBe(urls[name]);
  }
});

test("a missing version or a path cannot name a release", () => {
  for (const version of [undefined, "", "../0.7.0", "0.7", "01.7.0"]) {
    expect(() => releaseUrls(version)).toThrow("release version must be X.Y.Z");
  }
});

test("the tooling version, app release URL, and both health copies agree", () => {
  const root = new URL("../../../", import.meta.url);
  const version = JSON.parse(
    readFileSync(new URL("packages/start/package.json", root), "utf8"),
  ).version;
  const app = JSON.parse(
    readFileSync(new URL("apps/start-scaffold/app.package.json", root), "utf8"),
  );
  expect(app.devDependencies["@tinker/start"]).toBe(releaseUrls(version)["@tinker/start"]);
  for (const name of ["start-min", "start-scaffold"]) {
    const health = readFileSync(
      new URL(`apps/${name}/tinker/components/health/health.ts`, root),
      "utf8",
    );
    expect(health.match(/baseVersion = "([^"]+)"/)[1]).toBe(version);
  }
});
