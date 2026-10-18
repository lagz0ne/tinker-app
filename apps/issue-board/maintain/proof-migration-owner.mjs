import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase } from "./proof-write.mjs";

const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const {
  database,
  databaseSetup,
  databaseUrl,
  migrate,
  databaseMigrationTimeout,
  databaseStop,
  leaseFrom,
  migrationLockKey,
} = await vite.ssrLoadModule("/tinker/components/database/index.server.ts");

const { drizzlePgCore } = await vite.ssrLoadModule("/tinker/components/database/modules.ts");

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const admin = new pg.Client({ connectionString });

const roots = [];

const clients = [];

const name = "migration_" + randomUUID().replaceAll("-", "");

let arrivals = 0;

let active = 0;

let overlap = false;

let held = Promise.withResolvers();

let entered = Promise.withResolvers();

try {
  await admin.connect();

  await admin.query(`CREATE DATABASE ${name}`);

  // Same public migration operation and real migrator; hold its native boundary
  // to prove ownership, rather than count a SQL error from racing DDL.
  for (let index = 0; index < 3; index++) {
    const url = new URL(connectionString);

    url.pathname = "/" + name;

    const client = new pg.Client({ connectionString: url.href });

    await client.connect();

    clients.push(client);

    const root = createScope({
      extensions: [databaseSetup],
      tags: [databaseUrl(url), databaseMigrationTimeout(2000)],
      presets: [
        preset(database, async () => writeDatabase(client, leaseFrom)),
        preset(drizzlePgCore, async () => {
          const real = await import("drizzle-orm/pg-core");

          return {
            ...real,
            migrate: async (...args) => {
              arrivals++;

              active++;

              overlap ||= active > 1;

              entered.resolve();

              try {
                await held.promise;

                return await real.migrate(...args);
              } finally {
                active--;
              }
            },
          };
        }),
      ],
    });

    roots.push(root);
  }
  let ready = 0;

  const calls = roots.map((root) =>
    root.ready.then(() => {
      ready++;
    }),
  );

  const completed = Promise.allSettled(calls);

  await entered.promise;

  // Observe each contender reaching the ownership query before checking overlap.
  const contenders = AbortSignal.timeout(5000);
  while (
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND query ILIKE '% AS owned%'",
        [clients.map((client) => client.processID)],
      )
    ).rows[0].count !== 3
  ) {
    contenders.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const before = arrivals;

  assert.equal(ready, 0, "startup must await migration completion");

  held.resolve();

  const results = await completed;

  assert.equal(before, 1, "migration owner must exclude concurrent migrators");

  assert.equal(overlap, false, "migration owner must exclude concurrent migrators");

  assert(
    results.every((result) => result.status === "fulfilled"),
    JSON.stringify(results),
  );

  assert.equal(
    (await clients[0].query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"))
      .rows[0].count,
    14,
  );

  console.log(
    "PASS migration owner: three callers; one active migrator; real journal and DDL once.",
  );

  // Exercise the actual entries, not three replicas of their scope wiring.
  await clients[0].query("SELECT pg_advisory_lock($1,$2)", [...migrationLockKey]);
  const commands = [];
  try {
    for (const command of ["server", "worker", "cli"]) {
      const { default: main } = await vite.ssrLoadModule(`/cmds/${command}.ts`);

      const stop = new AbortController();

      const url = new URL(connectionString);

      url.pathname = "/" + name;

      url.searchParams.set("application_name", `migration-${command}-${name}`);

      const trial = { command, stop, returned: false };

      trial.pending = main({
        env: {
          DATABASE_URL: url.href,
          DATABASE_MIGRATION_TIMEOUT_MS: "60000",
          OTEL_SERVICE_NAME: "proof-migration",
          PUBLIC_ORIGIN: "http://localhost:4327",
          AUTH_SECRET: "proof-secret-with-at-least-thirty-two-letters",
          SMTP_URL: "smtp://127.0.0.1:11026",
          SMTP_FROM: "proof@example.test",
          VICTORIA_TRACES_URL: "http://127.0.0.1:11428",
          VICTORIA_LOGS_URL: "http://127.0.0.1:19428",
        },
        args:
          command === "cli"
            ? ["--file", "missing-proof.csv", "--team", "ENG", "--actor", "proof@example.test"]
            : [],
        signal: stop.signal,
        stdout: { write() {} },
        stderr: { write() {} },
        exit(_code, reason) {
          trial.error = String(reason?.stack ?? reason);
          stop.abort(reason);
        },
      }).then(
        (app) => {
          trial.returned = true;
          return app;
        },
        (error) => {
          trial.returned = true;
          throw error;
        },
      );

      void trial.pending.catch(() => {});

      commands.push(trial);
    }
    for (const trial of commands) {
      const deadline = AbortSignal.timeout(5000);
      let waiting = false;
      while (!trial.returned && !deadline.aborted) {
        waiting = !!(
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_try_advisory_lock%'",
            [`migration-${trial.command}-${name}`],
          )
        ).rowCount;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        waiting && !trial.returned,
        `${trial.command} command must await the held migration owner before ready or work: ${trial.error ?? "no matching SQL"}`,
      );
    }
    console.log(
      "PASS migration owner: real server, worker and CLI entries all wait before ready or work.",
    );
  } finally {
    await clients[0].query("SELECT pg_advisory_unlock($1,$2)", [...migrationLockKey]);
    for (const trial of commands) trial.stop.abort();
    await Promise.allSettled(
      commands.map(async (trial) => {
        const app = await trial.pending;
        await app.closed;
      }),
    );
  }

  await admin.query("SELECT pg_advisory_lock($1,$2)", [...migrationLockKey]);

  const bounded = createScope({
    tags: [databaseUrl(new URL(connectionString)), databaseMigrationTimeout(100)],
  });

  roots.push(bounded);

  await bounded.ready;

  const refused = await bounded.settle(migrate, { signal: new AbortController().signal });

  assert.equal(refused.status, "failed", "migration wait deadline must fail startup");

  assert.equal(refused.error.kind, "MigrationBusy", "migration wait deadline must be typed");

  await admin.query("SELECT pg_advisory_unlock($1,$2)", [...migrationLockKey]);

  console.log("PASS migration owner: typed bounded wait; no migration before ownership.");

  const owner = new pg.Client({ connectionString });

  await owner.connect();

  clients.push(owner);

  await owner.query("SELECT pg_advisory_lock($1,$2)", [...migrationLockKey]);

  const pid = (await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

  owner.on("error", () => {});

  const recovered = bounded.settle(migrate, { signal: new AbortController().signal });

  await admin.query("SELECT pg_terminate_backend($1)", [pid]);

  assert.equal((await recovered).status, "success", "migration owner death must allow recovery");

  console.log("PASS migration owner: backend death releases ownership; next caller recovers.");
  await admin.query("SELECT pg_advisory_lock($1,$2)", [...migrationLockKey]);

  const stop = new AbortController();

  const cancelUrl = new URL(connectionString);

  cancelUrl.searchParams.set("application_name", "migration-cancel-" + name);

  const cancellable = createScope({
    extensions: [databaseSetup],
    tags: [databaseUrl(cancelUrl), databaseMigrationTimeout(60000), databaseStop(stop.signal)],
  });

  roots.push(cancellable);

  const cancelled = cancellable.ready.then(
    () => null,
    (error) => error,
  );

  const deadline = AbortSignal.timeout(5000);

  while (
    !(
      await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_try_advisory_lock%'",
        ["migration-cancel-" + name],
      )
    ).rowCount
  ) {
    deadline.throwIfAborted();
  }

  const reason = Object.assign(new Error("startup migration cancelled"), { name: "AbortError" });

  stop.abort(reason);

  const joined = await Promise.race([
    cancelled,
    new Promise((resolve) => setTimeout(() => resolve("not-settled"), 1500)),
  ]);

  await admin.query("SELECT pg_advisory_unlock_all()");

  assert.equal(
    joined,
    reason,
    "startup migration must settle on worker stop instead of waiting for its long deadline",
  );

  console.log(
    "PASS migration owner: worker stop interrupts the startup ownership wait and joins cleanup.",
  );
} finally {
  held.resolve();

  await admin.query("SELECT pg_advisory_unlock_all()").catch(() => {});

  await Promise.all(roots.map((root) => root.close()));

  await Promise.all(clients.map((client) => client.end().catch(() => {})));

  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);

  await admin.end();

  await vite.close();
}
