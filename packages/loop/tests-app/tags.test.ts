import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { loopConfig, reviewModel } from "@/tags";

/**
 * loop.json as the loopConfig tag reads it: the checked value, or the first problem.
 * @param raw - From a test; why: the parsed loop.json.
 */
async function read(raw: unknown) {
  try {
    const scope = createScope({ tags: [loopConfig(raw as never)] });
    const value = scope.resolve(loopConfig);
    await scope.close();
    return value;
  } catch (error) {
    const refused = error as {
      payload?: { cause?: { payload?: { issues?: { message: string }[] } } };
    };
    return refused.payload?.cause?.payload?.issues?.[0]?.message ?? String(error);
  }
}

test("a good loop.json reads with its gates, its base, and its review block", async () => {
  const gates = [{ name: "test", run: "vp test", timeout: 1000 }];
  const review = { command: ["claude", "{prompt}"], timeout: 2000 };

  expect(await read({ gates, base: "main", review })).toEqual({ gates, base: "main", review });
  expect(await read({ gates, base: 7 })).toEqual({ gates, base: null, review: {} });
  const longest = [{ name: "slow", run: "x", timeout: 2_147_483_647 }];
  expect(await read({ gates: longest })).toEqual({ gates: longest, base: null, review: {} });
});

test("the reviewModel tag defaults to Claude Opus 5.5", async () => {
  const scope = createScope({});

  expect(scope.resolve(reviewModel)).toBe("claude-opus-5-5");
  await scope.close();
});

const gate = { name: "a", run: "x" };

for (const [problem, raw, message] of [
  ["no file body", null, '"gates" must list at least one gate'],
  ["no gates", { gates: [] }, '"gates" must list at least one gate'],
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
  ["a review that is not an object", { gates: [gate], review: [] }, '"review" must be an object'],
  ["a null review", { gates: [gate], review: null }, '"review" must be an object'],
  ["a review that is a word", { gates: [gate], review: "claude" }, '"review" must be an object'],
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
    "a review command with an empty word",
    { gates: [gate], review: { command: ["claude", ""] } },
    '"review.command" must list the program and its arguments as strings',
  ],
  [
    "a review timeout of 1.5",
    { gates: [gate], review: { timeout: 1.5 } },
    '"review.timeout" must be a positive whole number of milliseconds',
  ],
] as const) {
  test(`loop.json with ${problem} is refused: ${message}`, async () => {
    expect(await read(raw)).toBe(message);
  });
}
