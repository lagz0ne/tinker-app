// Recheck the inherited live proofs with faults in copies only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";

const directory = process.env.BOARD_PROOF_LOG_DIR ?? ".tinker/prior-controls";
mkdirSync(directory, { recursive: true });

const faults = [
  {
    name: "issues",
    file: "issues.server.ts",
    from: "sql`${team.issueSeq} + 1`",
    to: "sql`${team.issueSeq} + 2`",
    reason: /AssertionError[^\n]*: issue numbers must be contiguous 1\.\.20/,
  },
  {
    name: "lock-order",
    file: "team-write.server.ts",
    from: '.orderBy(sql`${teamMember.userId} collate "C"`)',
    to: '.orderBy(sql`${teamMember.userId} collate "C" desc`)',
    reason: /could not obtain lock/,
  },
  {
    name: "comments",
    file: "team-write.server.ts",
    from: "!!(await history.find(tx, input.executionId, input.owner))",
    to: "false",
    reason: /AssertionError/,
  },
  {
    name: "outbox",
    file: "../../tinker/components/mail/delivery.server.ts",
    from: ".orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))\n      .limit(20)",
    to: ".orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))\n      .limit(19)",
    reason: /outbox claim must return batches of 20 and 1/,
  },
  {
    name: "smtp-auth",
    file: "../../tinker/components/mail/mail.server.ts",
    from: "auth: user ? { user, pass: decodeURIComponent(url.password) } : undefined,",
    to: "auth: undefined,",
    reason: /530|Authentication|authentication/,
  },
];

const paths = [];

try {
  for (const fault of faults) {
    const target = fault.file.startsWith("../")
      ? fault.file.replace("../../", "")
      : `src/backend/${fault.file}`;
    const source = readFileSync(target, "utf8");
    assert(source.includes(fault.from), `Missing fault site: ${fault.name}`);
    const sourcePath = "src/backend/prior-control.scratch.server.ts";

    writeFileSync(sourcePath, source.replace(fault.from, fault.to));
    paths.push(sourcePath);
    const result = spawnSync(process.execPath, [`maintain/proof-${fault.name}.mjs`], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        BOARD_PROOF_FAULT_FILE: target,
        BOARD_PROOF_FAULT_COPY: sourcePath,
      },
    });
    const output = result.stdout + result.stderr;
    writeFileSync(`${directory}/${fault.name}.log`, output);
    assert.equal(result.error, undefined, output);
    assert.notEqual(result.status, 0, `Broken ${fault.name} passed`);
    assert.match(output, fault.reason);
    console.log(
      `PASS negative inherited ${fault.name}: broken scratch source exits ${result.status}; ${directory}/${fault.name}.log`,
    );
    rmSync(paths.pop(), { force: true });
  }

  // The broken host copy has no SIGTERM stop, so SIGTERM kills the worker instead of exit 143.
  const hostPath = ".bench/main-host-control.scratch.mjs";
  const host = readFileSync("../../packages/start/lib/main-host.mjs", "utf8");
  const signals = "const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };";
  assert(
    host.includes(signals),
    "main-host.mjs no longer names its signal table; update this control",
  );
  mkdirSync(".bench", { recursive: true });
  writeFileSync(
    hostPath,
    host.replace(signals, "const signalCodes = { SIGHUP: 129, SIGINT: 130 };"),
  );
  paths.push(hostPath);
  const runnerPath = "maintain/worker-control.scratch.mjs";
  writeFileSync(
    runnerPath,
    readFileSync("maintain/worker.mjs", "utf8").replace(
      '"@tinker/start/main-host"',
      '"../.bench/main-host-control.scratch.mjs"',
    ),
  );
  paths.push(runnerPath);
  const proofPath = "maintain/proof-worker-host.scratch.mjs";
  writeFileSync(
    proofPath,
    readFileSync("maintain/proof-worker-host.mjs", "utf8").replace(
      '"./worker.mjs"',
      '"./worker-control.scratch.mjs"',
    ),
  );
  paths.push(proofPath);
  const result = spawnSync(process.execPath, [proofPath], { encoding: "utf8", timeout: 30_000 });
  writeFileSync(`${directory}/worker-host.log`, result.stdout + result.stderr);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /null !== 143/);
  console.log(
    `PASS negative inherited worker-host: no SIGTERM stop exits by signal; ${directory}/worker-host.log`,
  );
} finally {
  // Only written files are listed, and a missing one is fine, so cleanup never hides the real error.
  for (const path of paths.reverse()) rmSync(path, { force: true });
}
