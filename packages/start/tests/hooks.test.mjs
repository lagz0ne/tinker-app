import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { recordViolation, restartNote, startViolations } from "../lib/hooks.mjs";
import { prepare } from "../lib/prepare.mjs";
import { goodApp } from "./fixture.mjs";

const leak = {
  importer: "",
  importerLoc: { line: 6, column: 24 },
  specifier: "../lib/secret.server.ts",
  envType: "client",
  pattern: /\.server\./,
};

test("a build's boundary record starts empty, and keeps each violation once, at its spot", () => {
  const root = goodApp();
  const found = startViolations(root);
  const path = join(root, ".tinker/violations.json");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);

  const info = { ...leak, importer: join(root, "src/routes/leak.tsx") };
  recordViolation(root, found, info);
  recordViolation(root, found, info);

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([
    {
      env: "client",
      importer: "src/routes/leak.tsx:6:24",
      specifier: "../lib/secret.server.ts",
      rule: "/\\.server\\./",
    },
  ]);
});

test("tinker prepare and every tinker() load keep the last build's boundary record", () => {
  const root = goodApp();
  mkdirSync(join(root, ".tinker"));
  const kept = '[{"importer":"src/routes/leak.tsx:6:24"}]\n';
  writeFileSync(join(root, ".tinker/violations.json"), kept);
  prepare(root);

  expect(readFileSync(join(root, ".tinker/violations.json"), "utf8")).toBe(kept);
});

test("dev restarts when the shell, a named file, or a seam file comes or goes, and not otherwise", () => {
  const root = goodApp();
  expect(restartNote(root, join(root, "src/routes/__root.tsx"), "added")).toBe(
    "tinker: src/routes/__root.tsx added; restarting",
  );
  expect(restartNote(root, join(root, "src/style.css"), "removed")).toBeNull();
  expect(restartNote(root, join(root, "cmds/router.ts"), "added")).toBe(
    "tinker: cmds/router.ts added; restarting",
  );
  expect(restartNote(root, join(root, "src/routes/index.tsx"), "added")).toBeNull();
});

test.each(["added", "removed", "changed"])("a component manifest %s restarts dev", (verb) => {
  const root = goodApp({ "tinker/components/mail/component.json": '{"requires":["database"]}' });

  const note = restartNote(root, join(root, "tinker/components/mail/component.json"), verb);

  expect(note).toBe(`tinker: tinker/components/mail/component.json ${verb}; restarting`);
  expect(restartNote(root, join(root, "tinker/components/mail/index.ts"), verb)).toBeNull();
});

test("dev watches configured command paths without a conventional router fallback", () => {
  const root = goodApp({
    "vite.config.ts":
      'export default {serverEntry: "cmds/http.ts", routerEntry: "cmds/browser.ts", startEntry: "cmds/middleware.ts"};',
  });
  expect(restartNote(root, join(root, "cmds/browser.ts"), "added")).toBe(
    "tinker: cmds/browser.ts added; restarting",
  );
  expect(restartNote(root, join(root, "cmds/middleware.ts"), "removed")).toBe(
    "tinker: cmds/middleware.ts removed; restarting",
  );
  expect(restartNote(root, join(root, "cmds/router.ts"), "added")).toBeNull();
});
