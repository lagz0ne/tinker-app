import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { reviewer } from "@/resources/reviewer";
import { appDir, childEnv, reviewModel } from "@/tags";

import { start, tempFolder, writeLoop } from "./temp";

const gates = [{ name: "ok", run: "true" }];

/**
 * A folder with a `claude` that saves its argv and stdin to called.json and prints "reviewed".
 * @param wait - From a test; why: ms to sleep first, for a timeout test.
 */
function fakeClaude(wait = 0) {
  const tools = tempFolder();
  writeFileSync(
    join(tools, "claude"),
    [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      `setTimeout(() => {`,
      `  fs.writeFileSync(${JSON.stringify(join(tools, "called.json"))}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));`,
      "  console.log('reviewed');",
      `}, ${wait});`,
      "",
    ].join("\n"),
  );
  chmodSync(join(tools, "claude"), 0o755);
  return {
    env: { PATH: `${tools}:${dirname(process.execPath)}` },
    called: join(tools, "called.json"),
  };
}

const defaultArgs = [
  "--restricted",
  "--tools",
  "Read,Grep,Glob",
  "--allowedTools",
  "Read,Grep,Glob",
  "--permission-mode",
  "dontAsk",
  "--strict-mcp-config",
  "--no-session-persistence",
];

test("the default reviewer is claude with the reviewModel tag; the prompt goes on stdin and is saved", async () => {
  const app = tempFolder();
  const claude = fakeClaude();
  writeLoop(app, { gates });
  const scope = createScope({
    tags: [appDir(app), childEnv(claude.env)],
  });
  const { ask } = scope.resolve(reviewer);

  const ending = await ask("Review this change.");
  await scope.close();

  expect(ending).toBe(null);
  expect(JSON.parse(readFileSync(claude.called, "utf8"))).toEqual({
    argv: ["-p", "--model", "claude-opus-5-5", ...defaultArgs],
    stdin: "Review this change.",
  });
  expect(readFileSync(join(app, ".loop/review/prompt.md"), "utf8")).toBe("Review this change.");
  expect(readFileSync(join(app, ".loop/review/output.txt"), "utf8")).toBe("reviewed\n");
  expect(existsSync(join(app, ".loop/review/stderr.log"))).toBe(true);
});

test("a reviewModel binding picks the default reviewer's model", async () => {
  const app = tempFolder();
  const claude = fakeClaude();
  writeLoop(app, { gates });
  const tags = [appDir(app), childEnv(claude.env), reviewModel("a-model")];
  const scope = createScope({ tags });
  const { ask } = scope.resolve(reviewer);

  await ask("p");
  await scope.close();

  expect(JSON.parse(readFileSync(claude.called, "utf8")).argv.slice(0, 3)).toEqual([
    "-p",
    "--model",
    "a-model",
  ]);
});

test("a loop.json review command gets the prompt as its one {prompt} word, and no stdin", async () => {
  const app = tempFolder();
  const claude = fakeClaude();
  const review = { command: ["claude", "--prompt", "{prompt}"] };
  writeLoop(app, { gates, review });
  const scope = createScope({
    tags: [appDir(app), childEnv(claude.env)],
  });
  const { ask } = scope.resolve(reviewer);

  await ask("- a prompt that starts like an option");
  await scope.close();

  expect(JSON.parse(readFileSync(claude.called, "utf8"))).toEqual({
    argv: ["--prompt", "- a prompt that starts like an option"],
    stdin: "",
  });
});

test("the loop.json review timeout stops a slow reviewer, and a caller's stop stops it too", async () => {
  const app = tempFolder();
  const claude = fakeClaude(30_000);
  const review = { timeout: 300 };
  writeLoop(app, { gates, review });
  const scope = createScope({
    tags: [appDir(app), childEnv(claude.env)],
  });
  const { ask } = scope.resolve(reviewer);
  const stop = new AbortController();

  const timedOut = await ask("p");
  const stopped = ask("p", stop.signal);
  stop.abort();
  const endings = [timedOut, await stopped];
  await scope.close();

  expect(endings).toEqual(["timed out after 300 ms", "was stopped"]);
}, 15_000);

/** @param app - From a test; why: the app whose reviewer to open, with a plain loop.json. */
function open(app: string) {
  writeLoop(app, { gates });
  const scope = createScope({ tags: [appDir(app), childEnv({ PATH: process.env.PATH })] });
  return { asker: scope.resolve(reviewer), close: () => scope.close() };
}

test("the review rules are the app's tinker-review skill, else its Start's rules.md, else neither", async () => {
  const withSkill = tempFolder();
  mkdirSync(join(withSkill, ".agents/skills/tinker-review"), { recursive: true });
  writeFileSync(join(withSkill, ".agents/skills/tinker-review/SKILL.md"), "SKILL\n");
  const withStart = tempFolder();
  start(withStart, "2.0.0", "### C: close\n\n- `C3` Close it.\n");
  const neither = tempFolder();
  const read = async (app: string) => {
    const { asker, close } = open(app);
    try {
      return asker.rules();
    } catch (error) {
      return (error as Error).message;
    } finally {
      await close();
    }
  };

  expect(await read(withSkill)).toEqual({ text: "SKILL\n", from: null });
  expect(await read(withStart)).toEqual({
    text: [
      "# Review a change",
      "",
      "This app has no tinker-review skill, so these are the review rules of its Start.",
      "Each finding names one rule ID from the list below.",
      "",
      "### C: close\n\n- `C3` Close it.",
    ].join("\n"),
    from: "@tinker/start 2.0.0 docs/rules.md",
  });
  expect(await read(neither)).toBe(
    `${join(neither, ".agents/skills/tinker-review/SKILL.md")} is missing, and the Start rules cannot be read (cannot find @tinker/start from ${neither}; install it to read its rules); review needs one of them`,
  );
});

test("the change goes to .loop/review as files, and the reply is read back from there", async () => {
  const app = tempFolder();
  const { asker, close } = open(app);

  asker.writeChange("+one\n", ["a.ts", "b.ts"]);
  asker.writeChange(null, []);
  const empty = readFileSync(join(app, ".loop/review/change.patch"), "utf8");
  asker.writeChange("+two\n", ["c.ts"]);
  writeFileSync(join(app, ".loop/review/output.txt"), "reply\n");
  const reply = asker.reply();
  await close();

  expect(empty).toBe("");
  expect(readFileSync(join(app, ".loop/review/change.patch"), "utf8")).toBe("+two\n");
  expect(readFileSync(join(app, ".loop/review/untracked.txt"), "utf8")).toBe("c.ts\n");
  expect(reply).toBe("reply\n");
});

test("a reported line past the end of its file becomes line 0 with a note; others stay", async () => {
  const app = tempFolder();
  writeFileSync(join(app, "two.ts"), "one\ntwo\n");
  writeFileSync(join(app, "one.ts"), "only");
  writeFileSync(join(app, "empty.ts"), "");
  const { asker, close } = open(app);
  const row = { id: "r", file: "two.ts", line: 2, trigger: "t" };

  const placed = [
    asker.place(row),
    asker.place({ ...row, line: 3 }),
    asker.place({ ...row, file: "one.ts", line: 2, trigger: "" }),
    asker.place({ ...row, file: "empty.ts", line: 1 }),
    asker.place({ ...row, file: "gone.ts", line: 9 }),
    asker.place({ ...row, line: null }),
  ];
  await close();

  expect(placed).toEqual([
    row,
    { ...row, line: 0, trigger: "t (The reviewer gave line 3; the file has 2 lines.)" },
    { ...row, file: "one.ts", line: 0, trigger: "The reviewer gave line 2; the file has 1 line." },
    {
      ...row,
      file: "empty.ts",
      line: 0,
      trigger: "t (The reviewer gave line 1; the file has 0 lines.)",
    },
    { ...row, file: "gone.ts", line: 9 },
    { ...row, line: null },
  ]);
});
