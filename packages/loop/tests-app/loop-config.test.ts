import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { loopConfig } from "@/resources/loop-config";
import { appDir, reviewModel } from "@/tags";

import { tempFolder, writeLoop } from "./temp";

/**
 * loop.json as the loopConfig resource reads it from an app: the checked value, or the message.
 * @param text - From a test; why: the file's text, or null for no file.
 */
async function read(text: string | null) {
  const app = tempFolder();
  if (text !== null) writeFileSync(join(app, "loop.json"), text);
  const scope = createScope({ tags: [appDir(app)] });
  try {
    return { app, value: await Promise.resolve(scope.resolve(loopConfig)) };
  } catch (error) {
    return { app, value: (error as Error).message };
  } finally {
    await scope.close();
  }
}

test("a good loop.json reads with its gates, its base, and its review block", async () => {
  const gates = [{ name: "test", run: "vp test", timeout: 1000 }];
  const review = { command: ["claude", "{prompt}"], timeout: 2000 };

  expect((await read(JSON.stringify({ gates, base: "main", review }))).value).toEqual({
    gates,
    base: "main",
    review,
  });
  expect((await read(JSON.stringify({ gates, base: 7 }))).value).toEqual({
    gates,
    base: null,
    review: {},
  });
  const longest = [{ name: "slow", run: "x", timeout: 2_147_483_647 }];
  expect((await read(JSON.stringify({ gates: longest }))).value).toMatchObject({ gates: longest });
});

test("no loop.json, or one that is not JSON, says so", async () => {
  const missing = await read(null);
  const broken = await read("{bad");

  expect(missing.value).toBe(`${join(missing.app, "loop.json")} is missing`);
  expect(broken.value).toMatch(/JSON/);
});

test("the reviewModel tag defaults to Claude Opus 5.5", async () => {
  const scope = createScope({});

  expect(scope.resolve(reviewModel)).toBe("claude-opus-5-5");
  await scope.close();
});

const gate = { name: "a", run: "x" };

for (const [problem, raw, message] of [
  ["no file body", null, '"gates" must list at least one gate'],
  ["a body that is a list", [], '"gates" must list at least one gate'],
  ["no gates", { gates: [] }, '"gates" must list at least one gate'],
  ["gates that are not a list", { gates: "a" }, '"gates" must list at least one gate'],
  [
    "a gate that is not an object",
    { gates: [null] },
    'each gate needs a "name" and a "run" string',
  ],
  ["a gate with no run", { gates: [{ name: "a" }] }, 'each gate needs a "name" and a "run" string'],
  [
    "a gate with an empty name",
    { gates: [{ name: "", run: "x" }] },
    'each gate needs a "name" and a "run" string',
  ],
  [
    "a zero gate timeout",
    { gates: [{ ...gate, timeout: 0 }] },
    'gate a: "timeout" must be a positive whole number of milliseconds',
  ],
  [
    "a gate timeout that is text",
    { gates: [{ ...gate, timeout: "5" }] },
    'gate a: "timeout" must be a positive whole number of milliseconds',
  ],
  [
    "a gate timeout past Node's timer",
    { gates: [{ ...gate, timeout: 2_147_483_648 }] },
    'gate a: "timeout" must be at most 2147483647 ms, about 24 days',
  ],
  ["two gates with one name", { gates: [gate, gate] }, "gate names must differ"],
  [
    "two gates with one log file",
    { gates: [gate, { name: "a?", run: "x" }, { name: "a!", run: "y" }] },
    "gate names must differ after each character other than a letter, digit, '.', '_', or '-' becomes '-', since each names a log file",
  ],
  ["a review that is a list", { gates: [gate], review: [] }, '"review" must be an object'],
  ["a null review", { gates: [gate], review: null }, '"review" must be an object'],
  ["a review that is a word", { gates: [gate], review: "claude" }, '"review" must be an object'],
  [
    "a review command with an empty word",
    { gates: [gate], review: { command: ["claude", ""] } },
    '"review.command" must list the program and its arguments as strings',
  ],
  [
    "an empty review command",
    { gates: [gate], review: { command: [] } },
    '"review.command" must list the program and its arguments as strings',
  ],
  [
    "a review command that is one string",
    { gates: [gate], review: { command: "claude -p" } },
    '"review.command" must list the program and its arguments as strings',
  ],
  [
    "a review timeout of 1.5",
    { gates: [gate], review: { timeout: 1.5 } },
    '"review.timeout" must be a positive whole number of milliseconds',
  ],
] as const) {
  test(`loop.json with ${problem} is refused: ${message}`, async () => {
    const app = tempFolder();
    writeLoop(app, raw);
    const scope = createScope({ tags: [appDir(app)] });

    let refused = "";
    try {
      scope.resolve(loopConfig);
    } catch (error) {
      refused = (error as Error).message;
    }
    await scope.close();

    expect(refused).toBe(`${join(app, "loop.json")}: ${message}`);
  });
}
