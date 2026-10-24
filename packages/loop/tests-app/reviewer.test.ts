import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { reviewer } from "@/resources/reviewer";
import { appDir, childEnv, reviewModel } from "@/tags";

import { tempFolder, writeLoop } from "./temp";

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
