import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vite-plus/test";
import { bytes } from "../../lib/checks/bytes.mjs";
import { runCheck } from "../../lib/doctor.mjs";
import { baseDir } from "../../lib/paths.mjs";
import { fixture, goodApp, installedApp, write } from "../fixture.mjs";

test("skips a workspace link: a source checkout has no pinned bytes", () => {
  const root = goodApp();
  expect(bytes(root)).toEqual({
    status: "skip",
    lines: [`workspace link to ${relative(root, baseDir)}; a source checkout has no pinned bytes`],
  });
});

test("fails when the base does not resolve", () => {
  expect(bytes(fixture({ "package.json": "{}" })).lines).toEqual([
    "@tinker/start does not resolve",
  ]);
});

test("passes when every installed file matches files.json", () => {
  expect(bytes(installedApp())).toEqual({ status: "ok", lines: ["2 files match files.json"] });
});

test("names each changed, missing, and added base file", () => {
  const root = installedApp();
  write(root, {
    "node_modules/@tinker/start/src/a.ts": "edited",
    "node_modules/@tinker/start/src/extra.ts": "x",
  });
  execFileSync("rm", [join(root, "node_modules/@tinker/start/src/b.ts")]);
  expect(bytes(root).lines).toEqual([
    "node_modules/@tinker/start/src/a.ts changed; an install drops base edits, so use an extension point",
    "node_modules/@tinker/start/src/b.ts missing; an install drops base edits, so use an extension point",
    "node_modules/@tinker/start/src/extra.ts added; an install drops base edits, so use an extension point",
  ]);
});

test("fails when the release has no files.json", () => {
  const root = installedApp();
  execFileSync("rm", [join(root, "node_modules/@tinker/start/files.json")]);
  expect(bytes(root).lines).toEqual(["files.json is missing from the base"]);
});

test("--fix restores the released bytes from the app's tarball", () => {
  const root = installedApp();
  write(root, {
    "node_modules/@tinker/start/src/a.ts": "edited",
    "node_modules/@tinker/start/src/extra.ts": "x",
  });
  expect(runCheck(root, bytes, true)).toEqual({
    status: "fixed",
    lines: ["restored 2 file(s) from base.tgz"],
  });
  expect(readFileSync(join(root, "node_modules/@tinker/start/src/a.ts"), "utf8")).toBe("a");
});

test("--fix without a tarball says how to reinstall, and the check still fails", () => {
  const root = installedApp({ "@tinker/start": "^9.0.0" });
  write(root, { "node_modules/@tinker/start/src/a.ts": "edited" });
  const result = bytes(root);
  expect(result.fix()).toBe("reinstall @tinker/start (^9.0.0) with your package manager");
  expect(runCheck(root, bytes, true).status).toBe("fail");
});
