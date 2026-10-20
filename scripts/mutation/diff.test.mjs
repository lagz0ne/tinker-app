import assert from "node:assert/strict";
import { test } from "node:test";

import { changedRanges, selectTests } from "./diff.mjs";

test("new-side diff ranges include additions, not deleted-only hunks", () => {
  assert.deepEqual(
    changedRanges(
      "+++ b/tinker/example.ts\n@@ -2,3 +2,4 @@\n+x\n@@ -9 +10 @@\n+y\n@@ -15,2 +16,0 @@",
    ),
    [
      { file: "tinker/example.ts", start: 2, end: 5 },
      { file: "tinker/example.ts", start: 10, end: 10 },
    ],
  );
});

test("reverse walk keeps both callers, ends at scope, and handles cycles", () => {
  const t1 = { file: "tests/one.test.ts", name: "one" };
  const t2 = { file: "tests/two.test.ts", name: "two" };
  const nodes = [
    { id: "leaf", file: "a.ts", start: 2, end: 8, tests: [t1], callers: ["left", "right"] },
    { id: "left", tests: [t1], callers: ["root"] },
    { id: "right", tests: [t2], callers: ["root", "leaf"] },
    { id: "root", kind: "createScope", tests: [], callers: [] },
  ];
  const result = selectTests(nodes, [{ file: "a.ts", start: 3, end: 3 }], [t1, t2]);
  assert.deepEqual(result.tests, [t1, t2]);
  assert.deepEqual(result.seams, ["root"]);
  assert.equal(result.fallback, false);
});

test("an unobserved handle or native helper uses every recorded test, not zero tests", () => {
  const test = { file: "tests/native.test.ts", name: "native" };
  const node = { id: "quiet", file: "a.ts", start: 1, end: 3, tests: [], callers: [] };
  for (const file of ["a.ts", "native.ts"]) {
    const result = selectTests([node], [{ file, start: 2, end: 2 }], [test]);
    assert.equal(result.fallback, true);
    assert.deepEqual(result.tests, [test]);
  }
});
