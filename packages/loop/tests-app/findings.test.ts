import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { findings } from "@/operations/findings";
import { appDir, childEnv, print, warn } from "@/tags";

import { start, tempFolder } from "./temp";

const rows = [
  {
    id: "f1",
    rule: "B1",
    severity: "nit",
    status: "fixed",
    file: "a.ts",
    line: 3,
    summary: "old",
    sha: "0123456789abcdef",
    round: 1,
  },
  {
    id: "o2",
    rule: "G1",
    severity: "important",
    status: "open",
    file: "test",
    line: null,
    summary: "red",
    fix: "Make it pass.",
    round: 2,
  },
  {
    id: "a3",
    rule: "Q9",
    severity: "question",
    status: "answered",
    file: "b.ts",
    line: 9,
    summary: "why",
    reason: "on purpose",
    round: 2,
  },
  {
    id: "o4",
    rule: "B1",
    severity: "nit",
    status: "open",
    file: "c.ts",
    line: 1,
    summary: "small",
    fix: "Tidy.",
    round: 2,
  },
];

/**
 * Run the findings operation on an app with `list` in its findings file.
 * @param list - From a test; why: the rows to show.
 * @param flags - From a test; why: --open and --rules.
 */
function run(list: object[], flags: { open?: boolean; rules?: boolean }) {
  const app = tempFolder();
  mkdirSync(join(app, ".loop"));
  writeFileSync(
    join(app, ".loop/findings.jsonl"),
    list.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  start(
    app,
    "1.0.0",
    "### B: boundary\n\n- `B1` Only cmds\n  reads inputs.\n\n### G: gates\n\n- `G1` Gates pass.\n",
  );

  const out: string[] = [];
  const tags = [appDir(app), childEnv({}), print((line) => out.push(line)), warn(() => {})];
  const scope = createScope({ tags });
  const outcome = scope.run(findings, { input: { open: false, rules: false, ...flags } });
  void scope.close();
  return { outcome, out };
}

test("findings lists open first, then answered, then fixed; important first in each", () => {
  expect(run(rows, {})).toEqual({
    outcome: "done",
    out: [
      "open important G1 test: red [o2] (round 2)",
      "  fix: Make it pass.",
      "open nit B1 c.ts:1: small [o4] (round 2)",
      "  fix: Tidy.",
      "answered question Q9 b.ts:9: why [a3] (round 2)",
      "  reason: on purpose",
      "fixed nit B1 a.ts:3: old [f1] (round 1)",
      "  fixed at 0123456789ab",
    ],
  });
});

test("--open shows only open findings, and --rules adds each rule's text on one line", () => {
  expect(run(rows, { open: true, rules: true }).out).toEqual([
    "open important G1 test: red [o2] (round 2)",
    "  rule: Gates pass.",
    "  fix: Make it pass.",
    "open nit B1 c.ts:1: small [o4] (round 2)",
    "  rule: Only cmds reads inputs.",
    "  fix: Tidy.",
  ]);
  expect(run([{ ...rows[2], status: "open", fix: "Say." }], { rules: true }).out).toContain(
    "  rule: not in this Start's rules.md",
  );
});

test("no findings says so", () => {
  expect(run([], {}).out).toEqual(["no findings"]);
  expect(run([rows[0]], { open: true }).out).toEqual(["no findings"]);
});
