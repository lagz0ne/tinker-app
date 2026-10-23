import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  await scope.close();

  expect(held).toBe(makeTestRandom({ seed: 7 }).uuid());
  expect(read).toEqual([{ id: "a", rule: "G1" }]);
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

test("a lock still held when the root closes is released", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir)] });
  const files = scope.resolve(store);
  const lock = join(dir, ".loop/findings.lock");

  void files.locked(() => new Promise(() => {}));
  const held = existsSync(lock);
  await scope.close();

  expect(held).toBe(true);
  expect(existsSync(lock)).toBe(false);
});
