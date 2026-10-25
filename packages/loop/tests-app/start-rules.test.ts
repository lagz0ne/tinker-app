import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { startRules } from "@/resources/start-rules";
import { appDir, childEnv } from "@/tags";

import { start, tempFolder } from "./temp";

const env = { PATH: process.env.PATH };

const rules =
  "# Rules\n\n### B: own the boundary\n\n- `B1` One,\r\n  two.\n\n### C: close\n\n- `C1` Close.\n";

/** @param dir - From a test; why: the folder to make a git repo. */
function gitInit(dir: string) {
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
}

/** @param app - From a test; why: the app whose Start to read. */
async function read(app: string) {
  const scope = createScope({ tags: [appDir(app), childEnv(env)] });
  const found = scope.resolve(startRules);
  try {
    return found.read();
  } catch (error) {
    return (error as Error).message;
  } finally {
    await scope.close();
  }
}

test("the app's Start is found at its repo's top, and rules.md parses into rules", async () => {
  const top = tempFolder();
  gitInit(top);
  const folder = start(top, "1.2.3", rules);
  mkdirSync(join(top, "apps/one"), { recursive: true });

  expect(await read(join(top, "apps/one"))).toEqual({
    version: "1.2.3",
    path: join(folder, "docs/rules.md"),
    rules: [
      { id: "B1", group: "B: own the boundary", lines: ["- `B1` One,", "  two."] },
      { id: "C1", group: "C: close", lines: ["- `C1` Close."] },
    ],
  });
});

test("a Start above the app's git repo, or none at all, is not the app's Start", async () => {
  const outside = tempFolder();
  start(outside, "1.2.3", rules);
  mkdirSync(join(outside, "app"));
  gitInit(join(outside, "app"));
  const none = tempFolder();

  expect(await read(join(outside, "app"))).toBe(
    `cannot find @tinker/start from ${join(outside, "app")}; install it to read its rules`,
  );
  expect(await read(none)).toBe(
    `cannot find @tinker/start from ${none}; install it to read its rules`,
  );
});

test("outside git, the lookup goes up the folders as Node does", async () => {
  const outside = tempFolder();
  start(outside, "1.2.3", rules);
  mkdirSync(join(outside, "app"));

  expect(await read(join(outside, "app"))).toMatchObject({ version: "1.2.3" });
});

test("an older Start, a broken package.json, and a broken rules.md each say so", async () => {
  const older = tempFolder();
  start(older, "0.9.0", null);
  const broken = tempFolder();
  mkdirSync(join(broken, "node_modules/@tinker/start/package.json"), { recursive: true });
  const bad = tempFolder();
  const folder = start(bad, "1.0.0", "### B: own the boundary\n\n- `C1` Wrong group.\n");
  const empty = tempFolder();
  start(empty, "1.0.0", "# Rules\n");

  expect(await read(older)).toBe(
    "@tinker/start 0.9.0 has no docs/rules.md; it is older than the rules file",
  );
  expect(await read(broken)).toBe(`cannot read @tinker/start from ${broken}: EISDIR`);
  expect(await read(bad)).toBe(
    `${join(folder, "docs/rules.md")}: line 3: rule C1 is in group B; its ID must start B`,
  );
  expect(await read(empty)).toBe(
    `${join(empty, "node_modules/@tinker/start/docs/rules.md")}: no rules found`,
  );
});

for (const [problem, text, message] of [
  ["a bad rule line", "### B: b\n\n- `b1` Lower.\n", 'line 3: a rule line reads "- `ID` text"'],
  ["a rule with no group", "- `B1` Alone.\n", "line 1: rule B1 is not under a"],
  [
    "a rule after a ## heading",
    "### B: b\n\n- `B1` One.\n\n## Judge\n\n- `B2` Two.\n",
    "line 7: rule B2 is not under a",
  ],
  [
    "a bad group heading",
    "### Boundary\n\n- `B1` One.\n",
    'line 1: a group heading reads "### <letter>: <title>"',
  ],
  [
    "a repeated ID",
    "### B: b\n\n- `B1` One.\n- `B1` Two.\n",
    "line 4: rule B1 is listed twice; first at line 3",
  ],
  [
    "a stray line in a group",
    "### B: b\n\n- `B1` One.\nstray\n",
    "line 4: in group B, a line is blank, a rule",
  ],
  [
    "a # line that is not a heading",
    "### B: b\n\n- `B1` One.\n\n#nope\n",
    'line 5: a group heading reads "### <letter>: <title>"',
  ],
] as const) {
  test(`rules.md with ${problem} names the line`, async () => {
    const app = tempFolder();
    start(app, "1.0.0", text);

    expect(await read(app)).toContain(message);
  });
}

test("prose before the first group and after a ## heading is free", async () => {
  const app = tempFolder();
  start(
    app,
    "1.0.0",
    "# Rules\n#1 note\n  - B9 not a rule\n### B: b\n\n- `B1` One.\n\n## Notes\n\nFree.\n\tTabs.\n",
  );

  expect(await read(app)).toMatchObject({
    rules: [{ id: "B1", group: "B: b", lines: ["- `B1` One."] }],
  });
});
