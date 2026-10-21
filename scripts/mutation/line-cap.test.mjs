import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capPlans, strykerPlugins } from "./line-cap.mjs";

const candidate = (id, line, extra = {}) => ({
  plan: "Run",
  mutant: {
    id,
    fileName: "/app/tinker/value.ts",
    location: { start: { line: line - 1, column: 1 }, end: { line: line - 1, column: 10 } },
    mutatorName: "BooleanLiteral",
    replacement: id,
    ...extra,
  },
});

test("line cap is stable across candidate order, ids, and checkout paths", () => {
  const original = [candidate("a", 2), candidate("b", 2), candidate("c", 3)];
  const reversed = structuredClone(original).reverse();
  const first = capPlans(original, ["tinker/value.ts:2-3"], "/app");
  const second = capPlans(reversed, ["tinker/value.ts:2-3"], "/app");

  assert.equal(first.length, 2);
  assert.deepEqual(
    first.toSorted((a, b) => a.line.localeCompare(b.line)),
    second.toSorted((a, b) => a.line.localeCompare(b.line)),
  );
  assert.equal(original.filter((plan) => plan.plan === "Run").length, 2);
  assert.equal(original.filter((plan) => plan.mutant.status === "Ignored").length, 1);

  const moved = reversed.map((plan) => ({
    ...plan,
    mutant: {
      ...plan.mutant,
      id: `new-${plan.mutant.id}`,
      status: undefined,
      fileName: "/other/tinker/value.ts",
    },
  }));
  const third = capPlans(moved, ["tinker/value.ts:2-3"], "/other");

  assert.deepEqual(
    new Set(third.map((entry) => entry.id)),
    new Set(first.map((entry) => `new-${entry.id}`)),
  );
});

test("arid candidates stay ignored and do not displace eligible mutants", () => {
  const plans = [candidate("arid", 2, { status: "Ignored" }), candidate("keep", 2)];

  assert.deepEqual(capPlans(plans, ["tinker/value.ts:2-2"], "/app"), [
    { line: "tinker/value.ts:2", id: "keep" },
  ]);
});

test("multiline mutants use the first changed line; unrelated lines fail closed", () => {
  const plan = candidate("wide", 1, {
    location: { start: { line: 0, column: 1 }, end: { line: 4, column: 0 } },
  });

  assert.equal(capPlans([plan], ["tinker/value.ts:3-4"], "/app")[0].line, "tinker/value.ts:3");
  assert.throws(() => capPlans([plan], ["tinker/value.ts:5-5"], "/app"), /outside diff/);
  assert.throws(
    () => capPlans([candidate("outside", 9)], ["tinker/value.ts:3-4"], "/app"),
    /outside diff/,
  );
  assert.throws(() => capPlans([], ["tinker/**"], "/app"), /explicit line ranges/);
});

test("native zero-based positions select the exact changed line", () => {
  const plan = candidate("at-boundary", 167);

  assert.deepEqual(capPlans([plan], ["tinker/value.ts:167-167"], "/app"), [
    { line: "tinker/value.ts:167", id: "at-boundary" },
  ]);
});

test("a reporter error suppresses every case and leaves a failure artifact", () => {
  const cwd = process.cwd();
  const folder = mkdtempSync(join(tmpdir(), "diff-cap-error-"));
  const plans = [candidate("must-not-run", 2)];

  mkdirSync(join(folder, "reports/mutation"), { recursive: true });

  try {
    process.chdir(folder);

    writeFileSync("reports/mutation/diff-plan.json", JSON.stringify({ mutate: ["invalid-glob"] }));
    const reporter = strykerPlugins[0].factory({ mutate: ["invalid-glob"] });

    assert.throws(
      () => reporter.onMutationTestingPlanReady({ mutantPlans: plans }),
      /explicit line ranges/,
    );
    assert.equal(plans[0].plan, "EarlyResult");
    assert.equal(plans[0].mutant.status, "Ignored");
    assert.equal(existsSync("reports/mutation/diff-line-cap-error.json"), true);
    assert.equal(existsSync("reports/mutation/diff-line-cap.json"), false);
  } finally {
    process.chdir(cwd);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("expanded statements keep a changed-line multiline mutant and ignore unplanned neighbors", () => {
  const wide = candidate("wide", 2, {
    location: { start: { line: 1, column: 1 }, end: { line: 2, column: 10 } },
  });
  const outside = candidate("neighbor", 3);
  const selected = capPlans([wide, outside], ["tinker/value.ts:2-2"], "/app", true);

  assert.deepEqual(selected, [{ line: "tinker/value.ts:2", id: "wide" }]);
  assert.equal(wide.plan, "Run");
  assert.equal(outside.mutant.status, "Ignored");
});

test("a multiline mutant crossing file shards has one global owner", () => {
  const wide = candidate("crossing", 2, {
    location: { start: { line: 1, column: 1 }, end: { line: 4, column: 10 } },
  });
  const owners = ["tinker/value.ts:2-2", "tinker/value.ts:5-5"];
  assert.deepEqual(capPlans([structuredClone(wide)], [owners[0]], "/app", true, owners), [
    { line: "tinker/value.ts:2", id: "crossing" },
  ]);

  const second = structuredClone(wide);
  assert.deepEqual(capPlans([second], [owners[1]], "/app", true, owners), []);
  assert.equal(second.mutant.status, "Ignored");
});
