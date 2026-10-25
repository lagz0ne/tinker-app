import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { commandLine } from "@/resources/command-line";

/** @param args - From a test; why: the command line to read in /work. */
async function read(...args: string[]) {
  const scope = createScope({});
  const line = scope.resolve(commandLine).read(args, "/work");
  await scope.close();
  return line;
}

test("a command line reads into its app folder, base, IDs, and flags", async () => {
  const lines = [
    await read("check", "--app", "../app/./x", "--base=main"),
    await read("answer", "a1", "--fixed", "--sha", "abc"),
    await read("rules", "--app=/abs", "--", "-B1", "c1"),
  ];

  expect(lines).toEqual([
    {
      app: "/app/x",
      base: "main",
      call: { command: "check", ids: [], open: false, rules: false, fixed: false },
    },
    {
      app: "/work",
      base: null,
      call: { command: "answer", ids: ["a1"], open: false, rules: false, fixed: true, sha: "abc" },
    },
    {
      app: "/abs",
      base: null,
      call: { command: "rules", ids: ["-B1", "c1"], open: false, rules: false, fixed: false },
    },
  ]);
});

test("a command line that does not fit its command names the problem", async () => {
  const problems = [
    await read(),
    await read("nope"),
    await read("check", "--app"),
    await read("check", "--open=yes"),
    await read("status", "--open"),
    await read("check", "id"),
    await read("answer"),
    await read("answer", "x"),
    await read("answer", "x", "--fixed", "--reason", "both"),
    await read("answer", "x", "--sha", "abc", "--reason", "why"),
    await read("answer", "x", "--reason", "  "),
  ];

  expect(problems.map((line) => ("problem" in line ? line.problem : null))).toEqual([
    "",
    "",
    "Option '--app <value>' argument missing\n",
    "Option '--open' does not take an argument\n",
    "tinker-loop status does not take --open\n",
    "tinker-loop check takes no IDs\n",
    "tinker-loop answer takes one finding ID\n",
    "tinker-loop answer: give --fixed or --reason, one of them\n",
    "tinker-loop answer: give --fixed or --reason, one of them\n",
    "tinker-loop answer: --sha goes with --fixed\n",
    "tinker-loop answer: --reason needs text\n",
  ]);
  expect(await read("check", "--wat")).toEqual({
    problem: expect.stringMatching(/^Unknown option '--wat'/),
  });
});

test("an outcome is its value, stopped, or error with the message to print", async () => {
  const scope = createScope({});
  const { outcome } = scope.resolve(commandLine);
  const failed = { status: "failed", error: new Error("boom"), kind: "error" } as const;

  const words = [
    outcome({ status: "success", value: "red" }, false),
    outcome({ status: "success", value: "stopped" }, false),
    outcome(failed, true),
    outcome(failed, false),
    outcome({ status: "failed", error: "text", kind: "error" }, false),
  ];
  await scope.close();

  expect(words).toEqual([
    { word: "red", message: null },
    { word: "stopped", message: null },
    { word: "stopped", message: null },
    { word: "error", message: "tinker-loop: boom" },
    { word: "error", message: "tinker-loop: text" },
  ]);
});
