import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { resolve } from "node:path";

// Build each broken scratch module at its real module ID. Never edit the source.
const directory = resolve(".bench/transaction-controls");
const target = "tinker/components/database/database.server.ts";
const original = readFileSync(target, "utf8");
mkdirSync(directory, { recursive: true });
const config = resolve(directory, "vite.config.ts");

writeFileSync(
  config,
  `import config from "../../vite.config";\nimport { proofFault } from "../../maintain/proof-fault.mjs";\nexport default {...config, plugins:[proofFault(), ...config.plugins]};\n`,
);

const cases = [
  {
    name: "commit-error-hidden",
    from: '.then(() => lease.query("COMMIT"))',
    to: '.then(() => lease.query("COMMIT").catch(() => {}))',
    expected: "failed COMMIT must be a client RPC error",
  },
  {
    name: "commit-not-awaited",
    from: 'then(() => lease.query("COMMIT"))',
    to: 'then(() => { void lease.query("COMMIT").catch(() => {}); })',
    expected: "no HTTP response byte may precede COMMIT",
  },
];

const good = resolve(directory, "good-dist");
rmSync(good, { recursive: true, force: true });
cpSync("dist", good, { recursive: true });

try {
  for (const fault of cases) {
    assert(original.includes(fault.from), fault.name + " source site missing");
    const copy = resolve(directory, fault.name + ".ts");
    writeFileSync(copy, original.replace(fault.from, fault.to));

    const env = { ...process.env, BOARD_PROOF_FAULT_FILE: target, BOARD_PROOF_FAULT_COPY: copy };
    const built = spawnSync("pnpm", ["exec", "vp", "build", "--config", config], {
      env,
      encoding: "utf8",
      timeout: 180_000,
    });
    writeFileSync(resolve(directory, fault.name + "-build.log"), built.stdout + built.stderr);
    assert.equal(built.status, 0, built.stderr);
    const proof = spawnSync(process.execPath, ["maintain/proof-transaction.mjs"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = proof.stdout + proof.stderr;
    writeFileSync(resolve(directory, fault.name + "-proof.log"), output);
    assert.notEqual(proof.status, 0, fault.name + " did not fail");
    assert(output.includes(fault.expected), fault.name + " failed for the wrong reason: " + output);
    console.log("PASS broken scratch copy fails: " + fault.name + " — " + fault.expected);
  }
  rmSync("dist", { recursive: true, force: true });

  cpSync(good, "dist", { recursive: true });

  const runnerFile = "src/transport/import-runner.server.ts";

  const runner = readFileSync(runnerFile, "utf8");

  const runnerCopy = resolve(directory, "row-commits.ts");

  writeFileSync(
    runnerCopy,
    runner.replace("offset += 100", "offset += 1").replace("offset + 100)", "offset + 1)"),
  );

  const cliGood = resolve(directory, "good-cli");

  rmSync(cliGood, { recursive: true, force: true });

  cpSync("dist-cli", cliGood, { recursive: true });

  try {
    const cliConfig = resolve(directory, "vite.cli.config.ts");

    writeFileSync(
      cliConfig,
      `import config from "../../vite.cli.config";\nimport {proofFault} from "../../maintain/proof-fault.mjs";\nexport default {...config,plugins:[proofFault(),...config.plugins]};\n`,
    );

    const built = spawnSync("pnpm", ["exec", "vp", "build", "--config", cliConfig], {
      encoding: "utf8",
      timeout: 180000,
      env: {
        ...process.env,
        BOARD_PROOF_FAULT_FILE: runnerFile,
        BOARD_PROOF_FAULT_COPY: runnerCopy,
      },
    });

    assert.equal(built.status, 0, built.stderr);

    const bad = spawnSync(process.execPath, ["maintain/proof-transaction.mjs"], {
      encoding: "utf8",
      timeout: 120000,
    });

    writeFileSync(resolve(directory, "row-commits-proof.log"), bad.stdout + bad.stderr);

    assert.notEqual(bad.status, 0, "row commits must fail the batch rollback proof");

    assert(
      (bad.stdout + bad.stderr).includes(
        "failed second batch must roll back every row in that batch",
      ),
      bad.stdout + bad.stderr,
    );

    console.log(
      "PASS broken scratch copy fails: per-row commits — batch 2 must roll back its first 50 writes",
    );
  } finally {
    rmSync("dist-cli", { recursive: true, force: true });

    cpSync(cliGood, "dist-cli", { recursive: true });
  }
  const resourceCases = [
    {
      name: "missing-rollback",
      from: "else await tx.rollback();",
      to: "else void 0;",
      expected: "a thrown step must roll back exactly once",
    },
    {
      name: "cancel-rollback",
      from: "else await tx.rollback();",
      to: 'else if (end.status !== "cancelled") await tx.rollback();',
      expected: "cancelled step must roll back exactly once",
    },
    {
      name: "released-rollback",
      from: "else await tx.rollback();",
      to: 'else if (end.status !== "released") await tx.rollback();',
      expected: "released transaction must roll back exactly once",
    },
    {
      name: "eager-begin",
      from: "return tx;",
      to: 'await lease.query("BEGIN"); return tx;',
      expected: "read-only call must issue no BEGIN or end SQL",
    },
    {
      name: "double-commit",
      from: 'if (state === "committed" || state === "rolledBack") return Promise.resolve();',
      to: "if (false) return Promise.resolve();",
      suffixFrom: 'const opened = state === "open";',
      suffixTo: 'const opened = state !== "idle";',
      expected: "explicit commit then defer must not issue a second end",
    },
    {
      name: "query-after-end",
      from: 'check() {\n        if (state === "committed" || state === "rolledBack") {',
      to: "check() {\n        if (false) {",
      expected: "query after explicit end must throw TransactionEnded",
    },
  ];
  for (const fault of resourceCases) {
    assert(original.includes(fault.from), fault.name + " source site missing");
    const copy = resolve(directory, fault.name + ".ts");
    let broken = original.replace(fault.from, fault.to);

    if (fault.suffixFrom) broken = broken.replace(fault.suffixFrom, fault.suffixTo);
    writeFileSync(copy, broken);
    const proof = spawnSync(process.execPath, ["maintain/proof-transaction-resource.mjs"], {
      encoding: "utf8",
      timeout: 45_000,
      env: { ...process.env, BOARD_PROOF_FAULT_FILE: target, BOARD_PROOF_FAULT_COPY: copy },
    });
    const output = proof.stdout + proof.stderr;
    writeFileSync(resolve(directory, fault.name + "-proof.log"), output);
    assert.notEqual(proof.status, 0, fault.name + " did not fail");
    assert(output.includes(fault.expected), fault.name + " failed for the wrong reason: " + output);
    console.log("PASS broken scratch copy fails: " + fault.name + " — " + fault.expected);
  }
} finally {
  rmSync("dist", { recursive: true, force: true });
  cpSync(good, "dist", { recursive: true });
  assert.equal(readFileSync(target, "utf8"), original, "real source was changed");
}
