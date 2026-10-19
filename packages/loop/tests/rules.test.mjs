import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { gateRule } from "../lib/findings.mjs";
import { parseRules } from "../lib/rules.mjs";
import { scans } from "../lib/scan.mjs";
import { fail, loop, loopJson, repo, setFindings } from "./fixture.mjs";

const repoRoot = join(import.meta.dirname, "../../..");
const startPackage = join(repoRoot, "packages/start");
const shipped = readFileSync(join(startPackage, "docs/rules.md"), "utf8");

const ids = [
  "G1",
  "B1",
  "B2",
  "B3",
  "B4",
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "O1",
  "O2",
  "O3",
  "O4",
  "O5",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "C7",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
];

/**
 * An app whose node_modules holds this repo's @tinker/start, as an install links it.
 * @param {Record<string, string>} files - From a test; why: the app's own files.
 */
function appWithStart(files = {}) {
  const app = repo(files);
  mkdirSync(join(app, "node_modules/@tinker"), { recursive: true });
  symlinkSync(startPackage, join(app, "node_modules/@tinker/start"));
  return app;
}

/** @param {string} text - From a test; why: the text from the first group heading on. */
function groups(text) {
  return text.slice(text.indexOf("\n### ") + 1);
}

test("rules.md lists every rule once, in its group, as the parser reads it", () => {
  const rules = parseRules(shipped);

  expect(rules.map((rule) => rule.id)).toEqual(ids);
  expect(rules.find((rule) => rule.id === "C3")).toEqual(
    expect.objectContaining({ group: "C: close before success" }),
  );
  expect(rules.find((rule) => rule.id === "I5").lines).toEqual([
    "- `I5` Four import groups at the top, no `.ts` endings,",
    "  blank lines between steps. Severity: nit.",
  ]);
});

test("every rule the check tool gives exists in rules.md", () => {
  const known = new Set(parseRules(shipped).map((rule) => rule.id));
  const given = [gateRule, ...scans.map((scan) => scan.rule)];

  expect(given.filter((id) => !known.has(id))).toEqual([]);
});

test("rules.md holds the review skill's rules word for word", () => {
  const skill = join(repoRoot, "apps/start-scaffold/.agents/skills/tinker-review/SKILL.md");
  const copies = [readFileSync(join(import.meta.dirname, "review-rules.fixture.md"), "utf8")];
  if (existsSync(skill)) {
    const text = readFileSync(skill, "utf8");
    copies.push(text.slice(text.indexOf("### G: gates"), text.indexOf("## Judge each finding")));
  }

  for (const copy of copies) expect(groups(shipped).trim()).toBe(copy.trim());
});

test("a repeated rule ID is an error, not a guess", () => {
  expect(() => parseRules("- `B1` One.\n- `B1` Two.\n")).toThrow("rule B1 is listed twice");
});

test("rules with no ID prints every rule from the Start the app resolves", async () => {
  const app = appWithStart();

  const run = await loop(app, "rules");

  expect(run.code).toBe(0);
  expect(run.stdout).toMatch(/^@tinker\/start \d+\.\d+\.\d+: .*docs\/rules\.md\n/);
  expect(run.stdout).toContain(groups(shipped).trim());
});

test("rules with IDs prints only those rules, in that order", async () => {
  const app = appWithStart();

  const run = await loop(app, "rules", "h5", "B1");

  expect(run.stdout.split("\n").slice(1)).toEqual([
    "",
    "- `H5` No skipped or quarantined test.",
    "  A fault control fails for its named cause.",
    "",
    "- `B1` Only `cmds/*` reads app inputs.",
    "  Other code never reads process globals or env files.",
    "",
  ]);
});

test("an unknown rule ID exits 64 and lists the known IDs", async () => {
  const app = appWithStart();

  const run = await loop(app, "rules", "B1", "Z9");

  expect(run.code).toBe(64);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(`unknown rule Z9; known rules: ${ids.join(", ")}`);
});

test("each app reads the rules of its own Start version", async () => {
  const app = repo({
    "node_modules/@tinker/start/package.json": JSON.stringify({
      name: "@tinker/start",
      version: "9.9.9",
      exports: { "./package.json": "./package.json" },
    }),
    "node_modules/@tinker/start/docs/rules.md": "### B: own the boundary\n\n- `B1` A newer rule.\n",
  });

  const run = await loop(app, "rules", "B1");

  expect(run.stdout).toContain("@tinker/start 9.9.9: ");
  expect(run.stdout).toContain("- `B1` A newer rule.");
});

test("an app without Start, or with a Start older than rules.md, exits 78", async () => {
  const bare = repo({ "readme.md": "" });
  const old = repo({
    "node_modules/@tinker/start/package.json": JSON.stringify({
      name: "@tinker/start",
      version: "0.9.0",
      exports: { "./package.json": "./package.json" },
    }),
  });

  const none = await loop(bare, "rules");
  const older = await loop(old, "rules");

  expect(none.code).toBe(78);
  expect(none.stderr).toContain("cannot find @tinker/start from");
  expect(older.code).toBe(78);
  expect(older.stderr).toContain("@tinker/start 0.9.0 has no docs/rules.md");
});

test("findings --rules shows each finding's rule text", async () => {
  const app = appWithStart({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  const [gate] = readFileSync(join(app, ".loop/findings.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  setFindings(app, [gate, { ...gate, id: "review-1", rule: "Q9", source: "review" }]);

  const plain = await loop(app, "findings");
  const withRules = await loop(app, "findings", "--rules");

  expect(plain.stdout).not.toContain("  rule: ");
  expect(withRules.stdout).toContain("  rule: Every gate in AGENTS.md passes.\n");
  expect(withRules.stdout).toContain("  rule: not in this Start's rules.md\n");
});

test("only the rules command takes IDs", async () => {
  const app = appWithStart({ "loop.json": loopJson({ red: fail }) });

  const run = await loop(app, "check", "B1");

  expect(run.code).toBe(64);
  expect(existsSync(join(app, ".loop"))).toBe(false);
});
