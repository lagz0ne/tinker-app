import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { gates } from "@/operations/gates";
import { appDir, childEnv, loopConfig, print, stop, warn } from "@/tags";

import { tempFolder } from "./temp";

const node = JSON.stringify(process.execPath);

/**
 * Run the gates operation over `list` in a temp app.
 * @param list - From a test; why: loop.json's gates.
 * @param signal - From a test; why: the stop, when a test needs one.
 */
async function run(list: { name: string; run: string; timeout?: number }[], signal?: AbortSignal) {
  const app = tempFolder();
  const out: string[] = [];
  const tags = [
    appDir(app),
    childEnv({ PATH: process.env.PATH }),
    loopConfig({ gates: list, base: null, review: {} }),
    print((line) => out.push(line)),
    warn(() => {}),
    stop(signal ?? new AbortController().signal),
  ];
  const scope = createScope({ tags });

  const results = await scope.run(gates);
  await scope.close();
  return { app, out, results };
}

test("every gate runs in order, even after a red one, each with its own log", async () => {
  const say = (text: string, code: number) =>
    `${node} -e "console.log(${JSON.stringify(text).replaceAll('"', "'")}); process.exit(${code})"`;
  const { app, out, results } = await run([
    { name: "first gate", run: say("all good", 0) },
    { name: "second", run: say("\\u001b[31mERROR: it broke\\u001b[0m", 1) },
    { name: "third", run: say("fine", 0) },
  ]);

  expect(out).toEqual(["PASS first gate", "FAIL second", "PASS third"]);
  expect(readFileSync(join(app, ".loop/gates/first-gate.log"), "utf8")).toBe("all good\n");
  expect(results.map(({ name, green }) => [name, green])).toEqual([
    ["first gate", true],
    ["second", false],
    ["third", true],
  ]);
  expect(results[1]?.finding).toMatchObject({
    rule: "G1",
    severity: "important",
    file: "second",
    line: null,
    summary: "ERROR: it broke",
    trigger: expect.stringMatching(
      / exited with code 1; full output in \.loop\/gates\/second\.log$/,
    ),
    fix: expect.stringMatching(/^Make `.+` pass\.$/),
    source: "check",
    id: expect.stringMatching(/^[0-9a-f]{12}$/),
  });
});

test("a red gate's summary is its first error line, else its first line, else how it ended", async () => {
  const lines = (text: string) => `${node} -e "process.stdout.write('${text}'); process.exit(2)"`;
  const { results } = await run([
    { name: "a", run: lines("start\\\\nnot ok 3 thing\\\\nend") },
    { name: "b", run: lines("only line\\\\n") },
    { name: "c", run: lines("") },
    { name: "d", run: lines(`fail ${"x".repeat(250)}`) },
    { name: "e", run: `${node} -e "setTimeout(() => {}, 5000)"`, timeout: 200 },
  ]);

  expect(results.map((result) => result.finding?.summary)).toEqual([
    "not ok 3 thing",
    "only line",
    "exited with code 2",
    `fail ${"x".repeat(192)}...`,
    "timed out after 200 ms",
  ]);
});

test("a stop before a gate runs no more gates", async () => {
  const stopped = new AbortController();
  stopped.abort("SIGINT");

  const { out, results } = await run([{ name: "a", run: "true" }], stopped.signal);

  expect([out, results]).toEqual([[], []]);
});
