import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import {
  registryItems,
  templateHostVersion,
} from "../../../apps/start-scaffold/maintain/registry-source.mjs";
import { copyTemplates } from "../../../apps/start-scaffold/maintain/template-sync.mjs";
import { releaseUrls } from "../lib/release.mjs";

test("release URLs name Start under tinker-app and Core/React under tinkered 0.9.0", () => {
  expect(releaseUrls("0.7.0")).toEqual({
    "@tinker/core":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-core-0.9.0.tgz",
    "@tinker/react":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-react-0.9.0.tgz",
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

test("the tooling and health copies agree while templates name their required host", () => {
  const root = new URL("../../../", import.meta.url);
  const version = JSON.parse(
    readFileSync(new URL("packages/start/package.json", root), "utf8"),
  ).version;
  const app = JSON.parse(
    readFileSync(new URL("apps/start-scaffold/app.package.json", root), "utf8"),
  );
  expect(app.devDependencies["@tinker/start"]).toBe(
    releaseUrls(templateHostVersion)["@tinker/start"],
  );
  for (const name of ["start-min", "start-scaffold"]) {
    const health = readFileSync(
      new URL(`apps/${name}/tinker/components/health/health.ts`, root),
      "utf8",
    );
    expect(health.match(/baseVersion = "([^"]+)"/)[1]).toBe(version);
  }
});

test("default exports pin the released host and refuse the old one", async () => {
  const out = await mkdtemp(join(tmpdir(), "start-export-contract-"));
  try {
    await copyTemplates(out);
    expect((await readdir(out)).sort()).toEqual(["demo", "small"]);
    for (const name of ["demo", "small"]) {
      const pkg = JSON.parse(await readFile(join(out, name, "package.json"), "utf8"));
      expect(pkg.devDependencies["@tinker/start"]).toBe(releaseUrls("0.12.0")["@tinker/start"]);
    }

    await expect(registryItems({ version: "0.9.0" })).rejects.toThrow(
      "require @tinker/start 0.12.0",
    );

    const { packages } = await registryItems();
    for (const pkg of Object.values(packages)) {
      expect(pkg.devDependencies["@tinker/start"]).toBe(releaseUrls("0.12.0")["@tinker/start"]);
      expect(JSON.stringify(pkg)).not.toMatch(/workspace:|catalog:/);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
