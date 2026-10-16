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

const commitFailureSite = original.match(
  /await lease\.query\("ROLLBACK"\)\.catch\(\(\) => \{\}\);\s+throw error;/,
)?.[0];

assert(commitFailureSite);

const cases = [
  {
    name: "commit-error-hidden",
    from: commitFailureSite,
    to: commitFailureSite.replace("throw error;", "void error;"),
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
  const resourceCases = [
    {
      name: "missing-rollback",
      from: "else await tx.rollback();",
      to: "else void 0;",
      expected: "a thrown step must roll back exactly once",
    },
    {
      name: "eager-begin",
      from: "return tx;",
      to: 'await lease.query("BEGIN"); return tx;',
      expected: "read-only call must issue no BEGIN or end SQL",
    },
    {
      name: "double-commit",
      from: 'if (state === "committed" || state === "rolledBack") return;',
      to: "if (false) return;",
      suffixFrom: 'const opened = state === "open";',
      suffixTo: "const opened = true;",
      expected: "explicit commit then defer must not issue a second end",
    },
    {
      name: "query-after-end",
      from: 'if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});',
      to: 'if (false) throw fail("TransactionEnded", {});',
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
