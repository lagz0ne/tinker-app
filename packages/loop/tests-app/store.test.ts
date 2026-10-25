import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createScope } from "@tinker/core";
import { makeTestClock, makeTestRandom } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { store } from "@/resources/store";
import { appDir } from "@/tags";

import { tempFolder } from "./temp";

test("findings round-trip under a lock whose token is ctx.random; .loop ignores itself", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir)], random: makeTestRandom({ seed: 7 }) });
  const files = scope.resolve(store);
  const lock = join(dir, ".loop/findings.lock");

  const held = await files.locked(async () => {
    files.writeFindings([{ id: "a", rule: "G1" }]);
    return readFileSync(lock, "utf8");
  });
  const read = files.findings();
  const lockedAfter = existsSync(lock);
  await scope.close();

  expect(held).toBe(makeTestRandom({ seed: 7 }).uuid());
  expect(read).toEqual([{ id: "a", rule: "G1" }]);
  expect(lockedAfter).toBe(false);
  expect(readFileSync(join(dir, ".loop/.gitignore"), "utf8")).toBe("*\n");
  expect(readdirSync(join(dir, ".loop")).sort()).toEqual([".gitignore", "findings.jsonl"]);
});

test("rounds and the last check round-trip; none yet reads as empty and null", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir)] });
  const files = scope.resolve(store);

  const before = [files.findings(), files.rounds(), files.lastCheck()];
  files.appendRound({ round: 2, source: "review", sha: null });
  files.writeLastCheck({ round: 1, sha: "abc", gates: [] });
  const after = [files.rounds(), files.lastCheck()];
  await scope.close();

  expect(before).toEqual([[], [], null]);
  expect(after).toEqual([
    [{ round: 2, source: "review", sha: null }],
    { round: 1, sha: "abc", gates: [] },
  ]);
});

test("a bad findings row, round, or last check names the file and line", async () => {
  const dir = tempFolder();
  mkdirSync(join(dir, ".loop"));
  writeFileSync(join(dir, ".loop/findings.jsonl"), '{"id":"a"}\n{"id":1}\n');
  writeFileSync(join(dir, ".loop/rounds.jsonl"), '{"round":2}\nnot json\n');
  writeFileSync(join(dir, ".loop/last-check.json"), "{");
  const scope = createScope({ tags: [appDir(dir)] });
  const files = scope.resolve(store);
  const loop = join(dir, ".loop");

  expect(() => files.findings()).toThrow(
    `${loop}/findings.jsonl:2 is not a finding: one JSON object with a string id`,
  );
  expect(() => files.rounds()).toThrow(
    `${loop}/rounds.jsonl:2 is not a round: one JSON object with a whole-number round; fix or delete that line`,
  );
  expect(() => files.lastCheck()).toThrow(
    new RegExp(`^${loop}/last-check.json: .+; run tinker-loop check to write it again$`),
  );
  await scope.close();
});

test("a lock older than 10 seconds on ctx.clock is broken; a lock taken over is not released", async () => {
  const dir = tempFolder();
  mkdirSync(join(dir, ".loop"));
  const lock = join(dir, ".loop/findings.lock");
  writeFileSync(lock, "a tool that died");
  const scope = createScope({
    tags: [appDir(dir)],
    clock: makeTestClock({ now: Date.now() + 11_000 }),
  });
  const files = scope.resolve(store);

  const ran = await files.locked(async () => {
    writeFileSync(lock, "a tool that broke this lock as stale");
    return "ran";
  });
  await scope.close();

  expect(ran).toBe("ran");
  expect(readFileSync(lock, "utf8")).toBe("a tool that broke this lock as stale");
});

test("close waits for a running locked callback, and only then releases its lock", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir)] });
  const files = scope.resolve(store);
  const lock = join(dir, ".loop/findings.lock");
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const order: string[] = [];

  const work = files.locked(async () => {
    await gate;
    order.push("callback done");
  });
  const closing = scope.close().then(() => order.push("closed"));
  await delay(100);
  const whileWaiting = { held: existsSync(lock), closed: order.includes("closed") };
  open();
  await closing;
  await work;

  expect(whileWaiting).toEqual({ held: true, closed: false });
  expect(order).toEqual(["callback done", "closed"]);
  expect(existsSync(lock)).toBe(false);
});

test("the next round is one more than any in the findings, the rounds, or the last check", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir)] });
  const files = scope.resolve(store);

  const first = files.nextRound();
  files.writeFindings([{ id: "a", round: 3 }]);
  files.appendRound({ round: 5, source: "review", sha: null });
  files.writeLastCheck({ round: 4, sha: null, gates: [] });
  const later = files.nextRound();
  writeFileSync(join(dir, ".loop/last-check.json"), "{");
  const broken = files.nextRound();
  await scope.close();

  expect([first, later, broken]).toEqual([1, 6, 6]);
});

test("a finding's id is stable: source, rule, file, and its summary with digit runs folded", async () => {
  const scope = createScope({ tags: [appDir(tempFolder())] });
  const files = scope.resolve(store);
  const id = (summary?: string) =>
    files.findingId({ source: "check", rule: "G1", file: "t", summary });

  const ids = [id(), id(""), id("took 12 ms"), id("took 345 ms"), id("took ms")];
  await scope.close();

  expect(ids[0]).toMatch(/^[0-9a-f]{12}$/);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).toBe(ids[3]);
  expect(new Set(ids).size).toBe(3);
});

test("opened, seen, and fixed stamp a row with the run's round and commit", async () => {
  const scope = createScope({ tags: [appDir(tempFolder())] });
  const files = scope.resolve(store);
  const run = { round: 4, sha: "abc", dirty: false };
  const row = {
    id: "x",
    rule: "B1",
    summary: "old",
    status: "open",
    sha: "s",
    dirty: true,
    seenSha: "q",
  };

  const found = {
    opened: files.opened({ id: "n", rule: "B1" }, run),
    openedNoSha: files.opened({ id: "n" }, { ...run, sha: null }),
    seen: files.seen(row, { id: "x", rule: "B1", summary: "new" }, run),
    seenAnswered: files.seen({ ...row, status: "answered" }, { id: "x" }, run).status,
    seenFixed: files.seen({ ...row, status: "fixed" }, { id: "x" }, run).status,
    fixed: files.fixed({ id: "x", status: "open", reason: "r" }, run),
    fixedDirty: files.fixed({ id: "x" }, { ...run, dirty: true }),
  };
  await scope.close();

  expect(found).toEqual({
    opened: { id: "n", rule: "B1", seenSha: "abc", round: 4, status: "open" },
    openedNoSha: { id: "n", round: 4, status: "open" },
    seen: { id: "x", rule: "B1", summary: "new", seenSha: "abc", round: 4, status: "open" },
    seenAnswered: "answered",
    seenFixed: "open",
    fixed: { id: "x", status: "fixed", reason: "r", round: 4, sha: "abc" },
    fixedDirty: { id: "x", status: "fixed", round: 4, sha: "abc", dirty: true },
  });
});

test("a gate's log lives in .loop/gates under a safe name, shown by its short path", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir)] });
  const files = scope.resolve(store);

  const log = files.gateLog("unit tests?");
  writeFileSync(log.path, "all good\n");
  const read = log.read();
  await scope.close();

  expect(log.path).toBe(join(dir, ".loop/gates/unit-tests-.log"));
  expect(log.shown).toBe(".loop/gates/unit-tests-.log");
  expect(read).toBe("all good\n");
});
