import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import {
  commit,
  fail,
  findingsOf,
  git,
  loop,
  loopJson,
  repo,
  setFindings,
  tempFolder,
} from "./fixture.mjs";

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

/**
 * An app whose node_modules holds a small @tinker/start of `version`.
 * @param {string} version - From a test; why: the Start version the app installed.
 * @param {string | null} rules - From a test; why: its docs/rules.md, or none.
 */
function fakeStart(version, rules) {
  return repo({
    "node_modules/@tinker/start/package.json": JSON.stringify({ name: "@tinker/start", version }),
    ...(rules === null ? {} : { "node_modules/@tinker/start/docs/rules.md": rules }),
  });
}

/** @param {string} text - From a test; why: the text from the first group heading on. */
function groups(text) {
  return text.slice(text.indexOf("\n### ") + 1);
}

test("rules.md lists every rule once, in its group, as the parser reads it", async () => {
  const app = appWithStart();

  const all = await loop(app, "rules");
  const unknown = await loop(app, "rules", "Z9");
  const i5 = await loop(app, "rules", "I5");
  const c3 = all.stdout.split("\n### ").find((part) => part.includes("\n- `C3` "));

  expect(unknown.stderr).toContain(`known rules: ${ids.join(", ")}\n`);
  expect(c3.split("\n")[0]).toBe("C: close before success");
  expect(i5.stdout.split("\n").slice(1)).toEqual([
    "",
    "- `I5` Four import groups at the top, no `.ts` endings,",
    "  blank lines between steps. Severity: nit.",
    "",
  ]);
});

test("every rule the check tool gives exists in rules.md", async () => {
  const app = appWithStart({
    ".gitignore": "node_modules/\n",
    "loop.json": loopJson({ red: fail }, "main"),
  });
  git(app, "checkout", "--quiet", "-b", "work");
  const every = [
    "process.env.X;",
    "Date.now();",
    "randomUUID();",
    "setInterval(() => {});",
    "class Thing {}",
    "fetch(url);",
    "it.skip(x);",
    "const y = z as unknown as number;",
  ];
  commit(app, { "src/every.ts": `${every.join("\n")}\n` }, "every scan");
  await loop(app, "check");

  const run = await loop(app, "findings", "--rules");
  const given = [...new Set(findingsOf(app).map((finding) => finding.rule))].sort((a, b) =>
    a.localeCompare(b),
  );

  expect(given).toEqual(["B1", "B3", "G1", "H2", "H3", "H5", "O1"]);
  expect(run.stdout).not.toContain("not in this Start's rules.md");
});

test("rules.md holds the review skill's rules word for word", () => {
  const skill = join(repoRoot, "apps/start-scaffold/.agents/skills/tinker-review/SKILL.md");
  const fixture = readFileSync(join(import.meta.dirname, "review-rules.fixture.md"), "utf8");
  const copies = [fixture.replace(/^<!--[\s\S]*?-->\n+/, "")];
  if (existsSync(skill)) {
    const text = readFileSync(skill, "utf8");
    copies.push(text.slice(text.indexOf("### G: gates"), text.indexOf("## Judge each finding")));
  }

  for (const copy of copies) expect(groups(shipped).trim()).toBe(copy.trim());
});

for (const [problem, text, message] of [
  [
    "a bad rule line",
    "### B: own the boundary\n\n- `b1` Lower case.\n",
    'line 3: a rule line reads "- `ID` text"',
  ],
  [
    "a rule line with no text",
    "### B: own the boundary\n\n- `B1`\n",
    'line 3: a rule line reads "- `ID` text"',
  ],
  ["a rule with no group", "- `B1` Alone.\n", "line 1: rule B1 is not under a"],
  [
    "a rule after a ## heading",
    "### B: own the boundary\n\n- `B1` One.\n\n## Judge\n\n- `B2` Two.\n",
    "line 7: rule B2 is not under a",
  ],
  [
    "a bad group heading",
    "### Boundary\n\n- `B1` One.\n",
    'line 1: a group heading reads "### <letter>: <title>"',
  ],
  [
    "an ID in another letter's group",
    "### B: own the boundary\n\n- `C1` One.\n",
    "line 3: rule C1 is in group B; its ID must start B",
  ],
  [
    "a repeated ID",
    "### B: own the boundary\n\n- `B1` One.\n- `B1` Two.\n",
    "line 4: rule B1 is listed twice; first at line 3",
  ],
  ["no rules", "# Start rules\n\nNothing yet.\n", "no rules found"],
  [
    "a list item without a backticked ID after a valid rule",
    "### B: own the boundary\n\n- `B1` One.\n- B2 Text\n",
    "line 4: in group B, a line is blank, a rule",
  ],
  [
    "a rule line with a leading space",
    "### B: own the boundary\n\n- `B1` One.\n - `B2` x\n",
    "line 4: in group B, a line is blank, a rule",
  ],
  [
    "a tab-indented line",
    "### B: own the boundary\n\n- `B1` One,\n\ttwo.\n",
    "line 4: in group B, a line is blank, a rule",
  ],
  [
    "an indented line after a blank line",
    "### B: own the boundary\n\n- `B1` One.\n\n  two.\n",
    "line 5: in group B, a line is blank, a rule",
  ],
  [
    "a ### heading with no space",
    "### B: own the boundary\n\n- `B1` One.\n\n###C: close\n",
    'line 5: a group heading reads "### <letter>: <title>"',
  ],
  [
    "a #### heading",
    "### B: own the boundary\n\n- `B1` One.\n\n#### C: close\n",
    'line 5: a group heading reads "### <letter>: <title>"',
  ],
]) {
  test(`the parser throws on ${problem}`, async () => {
    const run = await loop(fakeStart("1.0.0", text), "rules");

    expect(run.code).toBe(78);
    expect(run.stderr).toContain(message);
  });
}

test("text before the first group and after a ## heading is free prose", async () => {
  const text = [
    "# Start rules",
    "#1 note: prose, not a heading",
    "",
    "Each rule is a list item:",
    "  indented prose, - B9 not a rule",
    "### B: own the boundary",
    "",
    "- `B1` One,",
    "  two.",
    "",
    "## Notes",
    "",
    "Free text again.",
    "#tag is prose too",
    "\tand tabs.",
  ].join("\n");

  const run = await loop(fakeStart("1.0.0", text), "rules");

  expect(run.stdout.split("\n").slice(1)).toEqual([
    "",
    "### B: own the boundary",
    "",
    "- `B1` One,",
    "  two.",
    "",
  ]);
});

test("the parser reads Windows line ends", async () => {
  const text = "### B: own the boundary\r\n\r\n- `B1` One,\r\n  two.\r\n";

  const run = await loop(fakeStart("1.0.0", text), "rules");

  expect(run.stdout.split("\n").slice(1)).toEqual([
    "",
    "### B: own the boundary",
    "",
    "- `B1` One,",
    "  two.",
    "",
  ]);
});

test("a broken rules.md in the app's Start exits 78 and names the file and line", async () => {
  const app = fakeStart("1.0.0", "### B: own the boundary\n\n- `C1` Wrong group.\n");

  const run = await loop(app, "rules");

  expect(run.code).toBe(78);
  expect(run.stderr).toMatch(/docs\/rules\.md: line 3: rule C1 is in group B/);
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
  const app = fakeStart("9.9.9", "### B: own the boundary\n\n- `B1` A newer rule.\n");

  const run = await loop(app, "rules", "B1");

  expect(run.stdout).toContain("@tinker/start 9.9.9: ");
  expect(run.stdout).toContain("- `B1` A newer rule.");
});

test("an app without Start, or with a Start older than rules.md, exits 78", async () => {
  const none = await loop(repo({ "readme.md": "" }), "rules");
  const older = await loop(fakeStart("0.9.0", null), "rules");

  expect(none.code).toBe(78);
  expect(none.stderr).toContain("cannot find @tinker/start from");
  expect(none.stderr).toContain("install it to read its rules");
  expect(older.code).toBe(78);
  expect(older.stderr).toContain("@tinker/start 0.9.0 has no docs/rules.md");
});

test("a Start whose package.json cannot be read names the error code, not install", async () => {
  const app = repo({ "node_modules/@tinker/start/package.json/readme.md": "a folder, not a file" });

  const run = await loop(app, "rules");

  expect(run.code).toBe(78);
  expect(run.stderr).toContain(`cannot read @tinker/start from ${app}: EISDIR`);
  expect(run.stderr).not.toContain("install it");
});

test("NODE_PATH from the tool's runner never stands in for the app's Start", async () => {
  const runner = tempFolder({});
  mkdirSync(join(runner, "@tinker"), { recursive: true });
  symlinkSync(startPackage, join(runner, "@tinker/start"));
  const app = repo({ "readme.md": "" });
  const bin = fileURLToPath(new URL("../bin/tinker-loop.mjs", import.meta.url));

  const run = spawnSync(process.execPath, [bin, "rules"], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: runner },
  });

  expect(run.status).toBe(78);
  expect(run.stderr).toContain("cannot find @tinker/start from");
});

test("a Start above the app's git repo is not the app's Start", async () => {
  const outside = tempFolder({});
  mkdirSync(join(outside, "node_modules/@tinker"), { recursive: true });
  symlinkSync(startPackage, join(outside, "node_modules/@tinker/start"));
  mkdirSync(join(outside, "app"));
  git(join(outside, "app"), "init", "--quiet");

  const run = await loop(join(outside, "app"), "rules");

  expect(run.code).toBe(78);
  expect(run.stderr).toContain("cannot find @tinker/start from");
});

test("a Start at the repo's top is found from an app folder inside it", async () => {
  const root = repo({ "apps/one/readme.md": "" });
  mkdirSync(join(root, "node_modules/@tinker"), { recursive: true });
  symlinkSync(startPackage, join(root, "node_modules/@tinker/start"));

  const run = await loop(join(root, "apps/one"), "rules", "G1");

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("- `G1` Every gate in AGENTS.md passes.");
});

test("outside git, the lookup goes up the folders as Node does", async () => {
  const outside = tempFolder({ "app/readme.md": "" });
  mkdirSync(join(outside, "node_modules/@tinker"), { recursive: true });
  symlinkSync(startPackage, join(outside, "node_modules/@tinker/start"));

  const run = await loop(join(outside, "app"), "rules", "G1");

  expect(run.code).toBe(0);
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

test("a repeated ID prints its rule once", async () => {
  const run = await loop(appWithStart(), "rules", "B1", "b1");

  expect(run.stdout.split("- `B1` ")).toHaveLength(2);
});

test("only the rules command takes IDs, and each command takes only its own flags", async () => {
  const app = appWithStart({ "loop.json": loopJson({ red: fail }) });

  const ids = await loop(app, "check", "B1");
  const open = await loop(app, "check", "--open");
  const base = await loop(app, "rules", "--base", "main");
  const rules = await loop(app, "findings", "--rules", "--base", "main");

  expect([ids.code, open.code, base.code, rules.code]).toEqual([64, 64, 64, 64]);
  expect(ids.stderr).toContain("tinker-loop check takes no IDs");
  expect(open.stderr).toContain("tinker-loop check does not take --open");
  expect(base.stderr).toContain("tinker-loop rules does not take --base");
  expect(rules.stderr).toContain("tinker-loop findings does not take --base");
  expect(existsSync(join(app, ".loop"))).toBe(false);
});

test("the bin ignores a reader that closes the pipe early", async () => {
  const app = appWithStart();
  const bin = fileURLToPath(new URL("../bin/tinker-loop.mjs", import.meta.url));
  const child = spawn(process.execPath, [bin, "rules"], { cwd: app });
  child.stdout.destroy();
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));

  const code = await new Promise((resolve) => child.once("exit", resolve));

  expect(code).toBe(0);
  expect(Buffer.concat(errors).toString()).toBe("");
});
