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
  const root = "/app";
  expect(restartNote(root, "/app/src/routes/__root.tsx", "added")).toBe(
    "tinker: src/routes/__root.tsx added; restarting",
  );
  expect(restartNote(root, "/app/src/style.css", "removed")).toBe(
    "tinker: src/style.css removed; restarting",
  );
  expect(restartNote(root, "/app/src/lib/tinker.server.ts", "added")).toBe(
    "tinker: src/lib/tinker.server.ts added; restarting",
  );
  expect(restartNote(root, "/app/src/routes/index.tsx", "added")).toBeNull();
});
