// Recheck the inherited live proofs with faults in copies only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

const directory = process.env.BOARD_PROOF_LOG_DIR ?? ".tinker/prior-controls";
mkdirSync(directory, { recursive: true });

const faults = [
  {
    name: "issues",
    file: "issues.server.ts",
    from: "sql`${team.issueSeq} + 1`",
    to: "sql`${team.issueSeq} + 2`",
    reason: /AssertionError/,
  },
  {
    name: "lock-order",
    file: "issues.server.ts",
    from: '.orderBy(sql`${teamMember.userId} collate "C"`)',
    to: '.orderBy(sql`${teamMember.userId} collate "C" desc`)',
    reason: /could not obtain lock/,
  },
  {
    name: "comments",
    file: "comments.server.ts",
    from: "if (await history.find(tx, input.executionId, currentUser.id)) return;",
    to: "",
    reason: /AssertionError/,
  },
  {
    name: "outbox",
    file: "outbox.server.ts",
    from: ".limit(20)",
    to: ".limit(19)",
    reason: /AssertionError/,
  },
  {
    name: "smtp-auth",
    file: "alert-mail.server.ts",
    from: "auth: user ? { user, pass: decodeURIComponent(url.password) } : undefined,",
    to: "auth: undefined,",
    reason: /530|Authentication|authentication/,
  },
];

const paths = [];

try {
  for (const fault of faults) {
    const source = readFileSync(`src/backend/${fault.file}`, "utf8");
    assert(source.includes(fault.from), `Missing fault site: ${fault.name}`);
    const sourcePath = "src/backend/prior-control.scratch.server.ts";
    paths.push(sourcePath);
    writeFileSync(sourcePath, source.replace(fault.from, fault.to));
    const proof = readFileSync(`maintain/proof-${fault.name}.mjs`, "utf8");
    const original = `/src/backend/${fault.file}`;
    assert(proof.includes(original));
    const proofPath = "maintain/proof-prior.scratch.mjs";
    paths.push(proofPath);
    writeFileSync(
      proofPath,
      proof.replace(original, "/src/backend/prior-control.scratch.server.ts"),
    );

    const result = spawnSync(process.execPath, [proofPath], { encoding: "utf8", timeout: 60_000 });
    const output = result.stdout + result.stderr;
    writeFileSync(`${directory}/${fault.name}.log`, output);
    assert.equal(result.error, undefined, output);
    assert.notEqual(result.status, 0, `Broken ${fault.name} passed`);
    assert.match(output, fault.reason);
    console.log(
      `PASS negative inherited ${fault.name}: broken scratch source exits ${result.status}; ${directory}/${fault.name}.log`,
    );
    unlinkSync(paths.pop());
    unlinkSync(paths.pop());
  }

  const hostPath = "maintain/worker-control.scratch.mjs";
  paths.push(hostPath);
  const host = readFileSync("maintain/worker.mjs", "utf8");
  assert(host.includes('process.once("SIGTERM", () => stop.abort());'));
  writeFileSync(hostPath, host.replace('process.once("SIGTERM", () => stop.abort());', ""));
  const proofPath = "maintain/proof-worker-host.scratch.mjs";
  paths.push(proofPath);
  writeFileSync(
    proofPath,
    readFileSync("maintain/proof-worker-host.mjs", "utf8").replace(
      '"./worker.mjs"',
      '"./worker-control.scratch.mjs"',
    ),
  );
  const result = spawnSync(process.execPath, [proofPath], { encoding: "utf8", timeout: 30_000 });
  writeFileSync(`${directory}/worker-host.log`, result.stdout + result.stderr);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /null !== 0/);
  console.log(
    `PASS negative inherited worker-host: missing SIGTERM handler exits by signal; ${directory}/worker-host.log`,
  );
} finally {
  for (const path of paths.reverse()) unlinkSync(path);
}
