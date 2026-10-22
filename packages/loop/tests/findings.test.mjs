import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { lockFindings } from "./api.mjs";
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

test("check breaks a findings lock older than 10 seconds", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  const lock = join(app, ".loop/findings.lock");
  mkdirSync(join(app, ".loop"), { recursive: true });
  writeFileSync(lock, "someone else");
  utimesSync(lock, new Date(0), new Date(0));

  const run = await loop(app, "check");

  expect(run.code).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

test("check waits for a fresh lock, then writes after its owner releases it", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  const lock = join(app, ".loop/findings.lock");
  const released = join(app, "released");
  mkdirSync(join(app, ".loop"), { recursive: true });
  writeFileSync(lock, "someone else");
  const owner = spawn(
    process.execPath,
    [
      "-e",
      "setTimeout(() => { const fs = require('fs'); fs.rmSync(process.argv[1]); fs.writeFileSync(process.argv[2], ''); }, 500)",
      lock,
      released,
    ],
    { stdio: "ignore" },
  );

  const run = await loop(app, "check");
  await new Promise((resolve) =>
    owner.exitCode === null ? owner.once("exit", resolve) : resolve(),
  );

  expect(run.code).toBe(1);
  expect(statSync(join(app, ".loop/findings.jsonl")).mtimeMs).toBeGreaterThanOrEqual(
    statSync(released).mtimeMs,
  );
});

test("a lock is released only while it still holds its owner's token", async () => {
  const app = repo({ "readme.md": "" });
  const lock = join(app, ".loop/findings.lock");

  await (
    await lockFindings(app)
  )();
  const gone = existsSync(lock);
  const release = await lockFindings(app);
  writeFileSync(lock, "a tool that broke the lock as stale");
  await release();

  expect(gone).toBe(false);
  expect(readFileSync(lock, "utf8")).toBe("a tool that broke the lock as stale");
});
