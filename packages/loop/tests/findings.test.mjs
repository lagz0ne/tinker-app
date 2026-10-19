import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { fail, loop, loopJson, repo, setFindings } from "./fixture.mjs";

const finding = (id, status, severity, extra = {}) => ({
  id,
  rule: "G1",
  severity,
  file: id,
  line: null,
  summary: `${id} broke`,
  trigger: "t",
  fix: `fix ${id}`,
  source: "check",
  round: 1,
  status,
  ...extra,
});

test("findings lists open first, important first, with reasons and fix commits", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  setFindings(app, [
    finding("done", "fixed", "important", { sha: "abcdef0123456789" }),
    finding("why", "answered", "nit", { reason: "kept on purpose" }),
    finding("ask", "open", "question"),
    finding("must", "open", "important"),
  ]);

  const { code, stdout } = await loop(app, "findings");

  expect(code).toBe(0);
  expect(stdout).toBe(
    [
      "open important G1 must: must broke [must] (round 1)",
      "  fix: fix must",
      "open question G1 ask: ask broke [ask] (round 1)",
      "  fix: fix ask",
      "answered nit G1 why: why broke [why] (round 1)",
      "  reason: kept on purpose",
      "fixed important G1 done: done broke [done] (round 1)",
      "  fixed at abcdef012345",
      "",
    ].join("\n"),
  );
});

test("findings --open shows only open findings; an empty app has none", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  const empty = await loop(app, "findings");
  await loop(app, "check");
  setFindings(app, [finding("must", "open", "important"), finding("done", "fixed", "nit")]);

  const { stdout } = await loop(app, "findings", "--open");

  expect(empty.stdout).toBe("no findings\n");
  expect(stdout).toContain("must");
  expect(stdout).not.toContain("done");
});

for (const [kind, row] of [
  ["not JSON", "{not json"],
  ["not an object", "[1, 2]"],
  ["without a string id", '{"rule":"G1"}'],
]) {
  test(`a findings line ${kind} names the file and line and exits 78`, async () => {
    const app = repo({ "loop.json": loopJson({ red: fail }) });
    await loop(app, "check");
    setFindings(app, [finding("must", "open", "important")]);
    appendFileSync(join(app, ".loop/findings.jsonl"), `${row}\n`);

    const run = await loop(app, "findings");

    expect(run.code).toBe(78);
    expect(run.stderr).toContain(
      "findings.jsonl:2 is not a finding: one JSON object with a string id",
    );
  });
}

for (const { kind, lock } of [
  {
    kind: "whose tool is gone",
    lock: () => ({ pid: spawnSync(process.execPath, ["-e", ""]).pid, old: false }),
  },
  { kind: "older than 30 seconds", lock: () => ({ pid: process.pid, old: true }) },
]) {
  test(`check breaks a findings lock ${kind}`, async () => {
    const app = repo({ "loop.json": loopJson({ red: fail }) });
    const path = join(app, ".loop/findings.lock");
    const { pid, old } = lock();
    mkdirSync(join(app, ".loop"), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid, at: "then" }));
    if (old) utimesSync(path, new Date(0), new Date(0));

    const run = await loop(app, "check");

    expect(run.code).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
}
