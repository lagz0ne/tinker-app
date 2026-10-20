import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { handleGraph, spanRecorder, writeSpanMap } from "./span-map.mjs";

const app = resolve(".");

test("caller instrumentation keeps real Core and chains the observer", () => {
  const plugin = spanRecorder({ app, events: "/tmp/mutation-map-test.jsonl" });

  const code =
    'import { operation, createScope as scope } from "@tinker/core"; const root = scope();';

  const result = plugin.transform(code, `${app}/tests/example.test.ts`);

  assert.match(result.code, /operation/);

  assert.match(result.code, /tracedScope as scope/);

  assert.match(result.code, /const root = scope\(\)/);

  const bridge = plugin.load(plugin.resolveId("virtual:mutation-observe"));

  assert.match(bridge, /previous\?\.export\?\.\(span\)/);

  assert.match(bridge, /span: span.name/);

  assert.equal(plugin.transform(code, `${app}/node_modules/example.ts`), undefined);
});

test("real graph follows shorthand/controller/barrel dependencies back to the cmd", () => {
  const nodes = handleGraph(app);

  const claim = nodes.find((node) => node.name === "claimMailBatch");

  const tx = nodes.find((node) => node.name === "transaction");

  const deliver = nodes.find((node) => node.name === "deliverMailBatch");

  assert(claim.depends.includes(tx.id));

  assert(claim.callers.includes(deliver.id));

  assert(
    nodes.find((node) => node.id === "cmds/worker.ts#main").depends.includes(deliver.id) ||
      nodes
        .find((node) => node.id === "cmds/worker.ts#main")
        .depends.some((id) => id.includes("runMail")),
  );
});

test("map deduplicates test names and names unobserved handles as gaps", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "mutation-map-"));

  try {
    mkdirSync(resolve(directory, "report"));

    const events = resolve(directory, "events.jsonl");

    const row = {
      file: resolve(app, "tests/mail-delivery.test.ts"),
      name: "sends mail",
      span: "outbox.claim",
    };

    writeFileSync(events, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);

    const map = writeSpanMap(app, events, resolve(directory, "report/map.json"));

    assert.equal(map.nodes.find((node) => node.name === "claimMailBatch").tests.length, 1);

    assert(map.gaps.some((id) => id.endsWith("#transaction")));

    assert.equal(map.tests.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
