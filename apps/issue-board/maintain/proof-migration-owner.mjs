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

const { database, databaseSetup, databaseUrl, migrate, databaseMigrationTimeout, leaseFrom } =
  await vite.ssrLoadModule("/tinker/components/database/index.server.ts");

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

  // Give all contenders a full poll interval to expose an unguarded migrator.
  await new Promise((resolve) => setTimeout(resolve, 150));

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

  await admin.query("SELECT pg_advisory_lock(1414090315,1296648018)");

  const bounded = createScope({
    tags: [databaseUrl(new URL(connectionString)), databaseMigrationTimeout(100)],
  });

  roots.push(bounded);

  await bounded.ready;

  const refused = await bounded.settle(migrate, { signal: new AbortController().signal });

  assert.equal(refused.status, "failed", "migration wait deadline must fail startup");

  assert.equal(refused.error.kind, "MigrationBusy", "migration wait deadline must be typed");

  await admin.query("SELECT pg_advisory_unlock(1414090315,1296648018)");

  console.log("PASS migration owner: typed bounded wait; no migration before ownership.");

  const owner = new pg.Client({ connectionString });

  await owner.connect();

  clients.push(owner);

  await owner.query("SELECT pg_advisory_lock(1414090315,1296648018)");

  const pid = (await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

  owner.on("error", () => {});

  const recovered = bounded.settle(migrate, { signal: new AbortController().signal });

  await admin.query("SELECT pg_terminate_backend($1)", [pid]);

  assert.equal((await recovered).status, "success", "migration owner death must allow recovery");

  console.log("PASS migration owner: backend death releases ownership; next caller recovers.");
} finally {
  held.resolve();

  await Promise.all(roots.map((root) => root.close()));

  await Promise.all(clients.map((client) => client.end().catch(() => {})));

  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);

  await admin.end();

  await vite.close();
}
