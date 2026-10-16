// All faults live in scratch copies. Never change the real operation to run a control.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

const directory = process.env.BOARD_PROOF_LOG_DIR ?? ".tinker/import-controls";
mkdirSync(directory, { recursive: true });
const importer = readFileSync("src/backend/import.server.ts", "utf8");
const digest = readFileSync("src/backend/digest.server.ts", "utf8");
const digestProof = readFileSync("maintain/proof-digest.mjs", "utf8");
const paths = [];

const faults = [
  {
    name: "sorted-locks",
    check: "locks",
    from: '.orderBy(sql`${user.id} collate "C"`)',
    to: '.orderBy(sql`${user.id} collate "C" desc`)',
    reason: /could not obtain lock/,
  },
  {
    name: "team-lock",
    check: "team",
    from: '.for("no key update")',
    to: "",
    reason: /AssertionError/,
  },
  {
    name: "membership",
    check: "membership",
    from: "if (current.some((member) => !members.some((locked) => locked.id === member.userId)))",
    to: "if (false)",
    reason: /AssertionError/,
  },
  {
    name: "row-events",
    check: "effects",
    from: "await history.append(tx, member.id, executionId, [",
    to: "await Promise.resolve([",
    reason: /AssertionError/,
  },
  {
    name: "peer-mail",
    check: "effects",
    from: "AND ${user.id} <> ${writer.id}",
    to: "AND false",
    reason: /AssertionError/,
  },
  {
    name: "replay",
    check: "replay",
    from: "if (same) return;",
    to: "if (false) return;",
    reason: /AssertionError/,
  },
  {
    name: "update-version",
    check: "effects",
    from: ".set({ ...values, version: sql`${issue.version} + 1` })",
    to: ".set({ ...values })",
    reason: /AssertionError/,
  },
  {
    name: "rollback",
    check: "rollback",
    from: "return database.transaction(async (tx) => {",
    to: "return (async (tx) => {",
    suffixFrom: "return { changed };\n    });",
    suffixTo: "return { changed };\n    })(database);",
    reason: /AssertionError/,
  },
];

try {
  for (const fault of faults) {
    assert(importer.includes(fault.from), `Missing mutation site: ${fault.name}`);
    let source = importer.replace(fault.from, fault.to);
    if (fault.suffixFrom) {
      assert(source.includes(fault.suffixFrom));
      source = source.replace(fault.suffixFrom, fault.suffixTo);
    }
    const path = "src/backend/import-control.scratch.server.ts";
    paths.push(path);
    writeFileSync(path, source);

    const result = spawnSync(process.execPath, ["maintain/proof-import.mjs"], {
      encoding: "utf8",
      timeout: 45_000,
      env: {
        ...process.env,
        BOARD_IMPORT_SOURCE: "/src/backend/import-control.scratch.server.ts",
        BOARD_PROOF_CASE: fault.check,
      },
    });
    const output = result.stdout + result.stderr;
    writeFileSync(`${directory}/${fault.name}.log`, output);
    assert.equal(result.error, undefined, output);
    assert.notEqual(result.status, 0, `Broken ${fault.name} passed`);
    assert.match(output, fault.reason);
    console.log(
      `PASS negative ${fault.name}: broken scratch copy exits ${result.status}; ${directory}/${fault.name}.log`,
    );
    unlinkSync(paths.pop());
  }

  const replayPath = "maintain/proof-digest-replay.scratch.mjs";
  paths.push(replayPath);
  const reset = '  (await roots[1].resolve(digestDone)).day = "";\n  const beforeReplay';
  assert(digestProof.includes(reset));
  writeFileSync(replayPath, digestProof.replace(reset, "  const beforeReplay"));
  const replay = spawnSync(process.execPath, [replayPath], { encoding: "utf8", timeout: 45_000 });
  writeFileSync(`${directory}/digest-replay.log`, replay.stdout + replay.stderr);
  assert.equal(replay.error, undefined);
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /replay must reach SQL/);
  console.log(
    `PASS negative N5 replay: missing reset fails SQL count; ${directory}/digest-replay.log`,
  );
  unlinkSync(paths.pop());

  const conflictPath = "src/backend/digest-conflict.scratch.server.ts";
  paths.push(conflictPath);
  writeFileSync(conflictPath, digest.replace("ON CONFLICT (dedupe_key) DO NOTHING", ""));
  const conflictProof = "maintain/proof-digest-conflict.scratch.mjs";
  paths.push(conflictProof);
  writeFileSync(
    conflictProof,
    digestProof.replace(
      '"/src/backend/digest.server.ts"',
      '"/src/backend/digest-conflict.scratch.server.ts"',
    ),
  );
  const conflict = spawnSync(process.execPath, [conflictProof], {
    encoding: "utf8",
    timeout: 45_000,
  });
  writeFileSync(`${directory}/digest-conflict.log`, conflict.stdout + conflict.stderr);
  assert.equal(conflict.error, undefined);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stdout + conflict.stderr, /23505/);
  console.log(
    `PASS negative digest conflict: missing ON CONFLICT fails 23505; ${directory}/digest-conflict.log`,
  );
  unlinkSync(paths.pop());
  unlinkSync(paths.pop());

  const backoffPath = "src/backend/digest-backoff.scratch.server.ts";
  paths.push(backoffPath);
  writeFileSync(
    backoffPath,
    digest.replace("retry.at = clock.currentTimeMillis() + 30_000", "retry.at = 0"),
  );
  const outboxPath = "src/backend/outbox-backoff.scratch.server.ts";
  paths.push(outboxPath);
  writeFileSync(
    outboxPath,
    readFileSync("src/backend/outbox.server.ts", "utf8").replace(
      '"./digest.server"',
      '"./digest-backoff.scratch.server"',
    ),
  );
  const testPath = "tests/backoff-control.scratch.test.ts";
  paths.push(testPath);
  writeFileSync(
    testPath,
    `
import { createScope } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { queueDailyDigests } from "@/backend/digest-backoff.scratch.server";
import { deliverMailBatch, outboxWake, runMailWorker } from "@/backend/outbox-backoff.scratch.server";
` +
      readFileSync("tests/worker.test.ts", "utf8")
        .split('test("failed digest waits')[1]
        .replace(/^/, 'test("failed digest waits'),
  );
  const backoff = spawnSync("vp", ["test", testPath, "--maxWorkers=1", "--no-file-parallelism"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, VITEST_MAX_WORKERS: "1", VP_RUN_CONCURRENCY_LIMIT: "1" },
  });
  const backoffOutput = backoff.stdout + backoff.stderr;
  writeFileSync(`${directory}/digest-backoff.log`, backoffOutput);
  assert.equal(backoff.error, undefined);
  assert.notEqual(backoff.status, 0);
  assert.match(backoffOutput, /expected 2 to be 1/);
  console.log(
    `PASS negative N8 backoff: repeated wakes run extra SQL ticks; ${directory}/digest-backoff.log`,
  );
} finally {
  for (const path of paths.reverse()) unlinkSync(path);
}
