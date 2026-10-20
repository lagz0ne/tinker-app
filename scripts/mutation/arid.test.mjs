import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

import { shouldIgnore } from "./arid.mjs";

const app = createRequire(resolve("package.json"));
const core = createRequire(app.resolve("@stryker-mutator/core"));
const instrumenter = createRequire(core.resolve("@stryker-mutator/instrumenter"));
const { parse } = instrumenter("@babel/parser");
const { default: traverse } = instrumenter("@babel/traverse");

for (const [source, ignored] of [
  ['ctx.log.error("failed", { attempt: 2 })', true],
  ['ctx.obs.child("mail.send", () => send())', true],
  ['operation({ label: "mail.send", run: () => 12 })', true],
  ['const sendTimeout = 7500', true],
  ['({ attributes: { "mail.kind": "smtp" } })', true],
  ['if (attempts >= 12) throw new Error("dead")', false],
  ['({ "status": "sent" })', false],
  ['const limit = 20', false],
  ['sender.error("must not vanish")', false],
]) {
  test(`arid selection: ${source}`, () => {
    const reasons = [];
    traverse(parse(source), { enter(path) { if (shouldIgnore(path)) reasons.push(shouldIgnore(path)); } });
    assert.equal(reasons.length > 0, ignored);
  });
}
