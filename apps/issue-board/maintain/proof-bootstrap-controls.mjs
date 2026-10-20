import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(".bench/bootstrap-controls");
mkdirSync(directory, { recursive: true });
const config = resolve(directory, "vite.config.ts");

writeFileSync(
  config,
  `import config from "../../vite.config";import tests from "../../vitest.config";import {proofFault} from "../../maintain/proof-fault.mjs";export default {...config,...tests,plugins:[proofFault(),...config.plugins]};\n`,
);

const cases = [
  {
    name: "migration-no-owner-loop",
    target: "tinker/components/database/database.server.ts",
    from: "while (true)",
    to: "while (false)",
    test: "tests/database-ownership.test.ts",
    reason: "migration must attempt the ownership lock first",
  },
  {
    name: "migration-healthy-release-on-error",
    target: "tinker/components/database/database.server.ts",
    from: "let broken = true;",
    to: "let broken = false;",
    test: "tests/database-ownership.test.ts",
    reason: "a failed migration must destroy its connection",
  },
  {
    name: "migration-ignores-worker-stop",
    target: "tinker/components/database/database.server.ts",
    from: "scope.run(migrate, { signal: resolve(databaseStop) })",
    to: "scope.run(migrate)",
    test: "tests/database-ownership.test.ts",
    reason: "startup must follow the worker stop",
  },
  {
    name: "worker-pool-read-ignores-stop",
    target: "tinker/components/database/database.server.ts",
    from: 'if (key !== "query" || !stopping)',
    to: "if (true)",
    test: "tests/database-ownership.test.ts",
    reason: "pool read must stop without waiting for its native query",
  },
  {
    name: "listener-keeps-caller-stop",
    target: "tinker/components/database/database.server.ts",
    from: 'signal?.removeEventListener("abort", abort);',
    to: "void signal;",
    test: "tests/database-ownership.test.ts",
    reason: "listener close must unsubscribe from caller stop",
  },
  {
    name: "expired-lease-send",
    target: "tinker/components/mail/delivery.server.ts",
    from: "row.leaseUntil!.getTime() - clock.currentTimeMillis() < budget",
    to: "false",
    test: "tests/mail-delivery.test.ts",
    reason: "remaining lease must cover send plus acknowledgement",
  },
  {
    name: "unsent-attempts-not-refunded",
    target: "tinker/components/mail/delivery.server.ts",
    from: "attempts: orm.sql`${mailOutbox.attempts} - 1`",
    to: "attempts: orm.sql`${mailOutbox.attempts}`",
    test: "tests/mail-delivery.test.ts",
    reason: "AssertionError: release must refund the unsent attempt:",
  },
  {
    name: "claim-extra-statement",
    target: "tinker/components/mail/delivery.server.ts",
    from: "const token = random.uuid();",
    to: "await tx.update(mailOutbox).set({ leaseToken: null }).where(sql`false`);\n    const token = random.uuid();",
    test: "tests/mail-delivery.test.ts",
    reason: "one claim must use one SQL statement",
  },
  {
    name: "exhausted-mail-index-missing",
    target: "tinker/components/database/database.server.ts",
    from: "migrator.readMigrationFiles({ migrationsFolder })",
    to: `migrator.readMigrationFiles({ migrationsFolder }).filter((migration) => !migration.sql.some((statement) => statement.includes('CREATE INDEX "mail_outbox_exhausted"')))`,
    test: "tests/mail-delivery.test.ts",
    reason: "AssertionError: exhausted claims must use the partial index:",
  },
  {
    name: "mail-commit-error-swallowed",
    target: "tinker/components/database/database.server.ts",
    from: '.then(() => lease.query("COMMIT"))',
    to: '.then(() => lease.query("COMMIT").catch(() => {}))',
    test: "tests/mail-commit-contract.test.ts",
    reason: "AssertionError: failed mail COMMIT must fail its call without reporting success:",
  },
  {
    name: "smtp-deadline-closes-other-sends",
    target: "tinker/components/mail/mail.server.ts",
    from: 'sockets.close(owned.connection, new Error("Mail send total timeout"));',
    to: "for (const sender of connections) { sockets.close(sender.connection); sender.transport.close(); }",
    test: "tests/mail-native-contract.test.ts",
    reason: "AssertionError: send timeout must leave other sends running:",
  },
  {
    name: "smtp-total-deadline",
    target: "tinker/components/mail/mail.server.ts",
    from: "clock.sleep(timeout, timer.signal)",
    to: "new Promise(() => {})",
    test: "tests/mail-deadline.test.ts",
    reason: "mail total deadline must end slow-progress send",
  },
  {
    name: "smtp-socket-not-aborted",
    target: "tinker/components/mail/sockets.server.ts",
    from: "socket.destroy(error);",
    to: "void socket;",
    test: "tests/mail-deadline.test.ts",
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
      process.execPath,
      [
        fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json"))),
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

    assert.equal(run.error, undefined, String(run.error));

    writeFileSync(resolve(directory, trial.name + ".log"), run.stdout + run.stderr);

    assert.equal(run.status, 1, run.stdout + run.stderr);

    assert((run.stdout + run.stderr).includes(trial.reason), run.stdout + run.stderr);

    console.log("PASS broken bootstrap control: " + trial.name + " fails the actual scope test.");
  }
} finally {
  rmSync(copies, { recursive: true, force: true });
}
