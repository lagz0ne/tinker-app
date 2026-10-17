import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const directory = resolve(".bench/bootstrap-controls");
mkdirSync(directory, { recursive: true });
const config = resolve(directory, "vite.config.ts");

writeFileSync(
  config,
  `import config from "../../vite.config";import {proofFault} from "../../maintain/proof-fault.mjs";export default {...config,plugins:[proofFault(),...config.plugins]};\n`,
);

const cases = [
  {
    name: "smtp-socket-not-aborted",
    target: "src/backend/alert-mail.server.ts",
    from: "sockets.abort();",
    to: "void sockets;",
    test: "tests/alert-mail.test.ts",
    reason: "active SMTP socket must close at total deadline",
  },
  {
    name: "idle-handle-not-ended",
    target: "tinker/components/database/database.server.ts",
    from: 'if (state === "idle" || state === "open") {',
    to: 'if (state === "open") {',
    test: "tests/transaction-lease.test.ts",
    reason: "an idle handle cannot query after close",
  },
  {
    name: "page-auth-deletes",
    target: "tinker/components/auth/auth.server.ts",
    from: "session: { deferSessionRefresh: true }",
    to: "session: { deferSessionRefresh: false }",
    reason: "page reads must not write any table",
  },
  {
    name: "sign-in-no-repair",
    target: "tinker/components/auth/auth.server.ts",
    from: "after: ({ userId }) => created.run({ input: { accountId: userId } }),",
    to: "after: async () => {},",
    reason: "sign-in must repair the missing stream",
  },
  {
    name: "bootstrap-inserts",
    target: "src/demo/backend/sync.server.ts",
    from: "history.read(tx,",
    to: "history.lock(tx,",
    reason: "page bootstrap must not INSERT sync_stream",
  },
  {
    name: "bootstrap-row-locks",
    target: "tinker/components/sync/history.server.ts",
    from: "await tx.select().from(stream).where(eq(stream.id, id));",
    to: 'await tx.select().from(stream).where(eq(stream.id, id)).for("update");',
    reason: "page bootstrap must not row-lock sync_stream",
  },
];

const copies = mkdtempSync(join(tmpdir(), "board-bootstrap-controls-"));

try {
  for (const trial of cases) {
    const source = readFileSync(trial.target, "utf8");

    assert(source.includes(trial.from), trial.name);

    const copy = resolve(copies, trial.name + ".ts");

    writeFileSync(copy, source.replaceAll(trial.from, trial.to));

    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "vp",
        "test",
        trial.test ?? "tests/bootstrap-read.test.ts",
        "--config",
        config,
        "--maxWorkers=1",
        "--no-file-parallelism",
      ],
      {
        env: { ...process.env, BOARD_PROOF_FAULT_FILE: trial.target, BOARD_PROOF_FAULT_COPY: copy },
        encoding: "utf8",
        timeout: 120000,
      },
    );

    writeFileSync(resolve(directory, trial.name + ".log"), run.stdout + run.stderr);

    assert.equal(run.status, 1, run.stdout + run.stderr);

    assert((run.stdout + run.stderr).includes(trial.reason), run.stdout + run.stderr);

    console.log("PASS broken bootstrap control: " + trial.name + " fails the actual scope test.");
  }
} finally {
  rmSync(copies, { recursive: true, force: true });
}
