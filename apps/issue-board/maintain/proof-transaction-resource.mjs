import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createScope, operation } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase } from "./proof-write.mjs";

const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { database, transaction, drizzleOrm, leaseFrom } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const client = new pg.Client({
  connectionString: "postgres://issue_board@127.0.0.1:15433/postgres",
});

await client.connect();
await client.query("CREATE TEMP TABLE tx_resource_proof(value int)");
const queries = [];
const handle = writeDatabase(client, leaseFrom);
const checkout = handle.checkout;

handle.checkout = async (guard) => {
  const lease = await checkout(guard);
  return {
    ...lease,
    query: async (text) => {
      queries.push(text);
      return lease.query(text);
    },
  };
};

const root = createScope({ presets: [preset(database, async () => handle)] });

const save = operation({
  label: "proof.step",
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }) => {
    await tx.execute(orm.sql`INSERT INTO tx_resource_proof VALUES(1)`);
    return "saved";
  },
});

const read = operation({
  label: "proof.readOnly",
  depends: { tx: transaction, database, orm: drizzleOrm },
  run: async ({ database, orm }) => database.execute(orm.sql`SELECT 1`),
});

const refuse = operation({
  label: "proof.refuse",
  depends: { step: save.controller },
  run: async ({ step }, { raise }) => {
    await step.run();
    raise("StepRefused", {});
  },
});

const complete = operation({
  label: "proof.earlyEnd",
  depends: { step: save.controller, tx: transaction },
  run: async ({ step, tx }) => {
    const value = await step.run();
    await tx.commit();
    await tx.commit();
    await tx.rollback();
    return value;
  },
});

const written = Promise.withResolvers();

const hold = operation({
  label: "proof.hold",
  depends: { step: save.controller },
  run: async ({ step }, { signal }) => {
    await step.run();
    written.resolve();
    await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  },
});

const ended = operation({
  label: "proof.endedQuery",
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }) => {
    await tx.execute(orm.sql`SELECT 1`);
    await tx.commit();
    await tx.execute(orm.sql`SELECT 2`);
  },
});

await root.ready;

try {
  await root.run(read, { signal: new AbortController().signal });
  assert.deepEqual(queries, [], "read-only call must issue no BEGIN or end SQL");
  console.log(
    "PASS live PostgreSQL: ordinary read and unused transaction issue no BEGIN/COMMIT/ROLLBACK.",
  );

  const failed = await root.settle(refuse, { signal: new AbortController().signal });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.kind, "StepRefused");
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"], "a thrown step must roll back exactly once");
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM tx_resource_proof")).rows[0].n,
    0,
  );
  console.log("PASS live PostgreSQL: thrown step issues exactly BEGIN/ROLLBACK; no saved row.");

  queries.length = 0;
  const stop = new AbortController();
  const cancelled = root.settle(hold, { signal: stop.signal });
  await written.promise;
  stop.abort();
  assert.equal((await cancelled).status, "cancelled");
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"], "cancelled step must roll back exactly once");
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM tx_resource_proof")).rows[0].n,
    0,
  );
  console.log(
    "PASS live PostgreSQL: mid-step cancel issues exactly BEGIN/ROLLBACK from the defer.",
  );

  queries.length = 0;

  await root.session(async (session) => {
    const tx = await session.resolve(transaction);

    const { sql } = await session.resolve(drizzleOrm);

    await tx.execute(sql`SELECT 1`);

    session.release(transaction);
  });

  assert.deepEqual(
    queries,
    ["BEGIN", "ROLLBACK"],
    "released transaction must roll back exactly once",
  );

  console.log("PASS live PostgreSQL: release(transaction) sends exactly BEGIN/ROLLBACK.");

  queries.length = 0;

  const committed = await root.settle(complete, { signal: new AbortController().signal });
  assert.equal(committed.status, "success");
  assert.equal(committed.value, "saved");
  assert.deepEqual(
    queries,
    ["BEGIN", "COMMIT"],
    "explicit commit then defer must not issue a second end",
  );
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM tx_resource_proof")).rows[0].n,
    1,
  );
  console.log(
    "PASS live PostgreSQL: explicit commit, repeated ends and defer issue exactly BEGIN/COMMIT.",
  );

  queries.length = 0;
  const invalid = await root.settle(ended, { signal: new AbortController().signal });
  assert.equal(invalid.status, "failed", "query after explicit end must fail");
  assert.equal(
    invalid.error.kind,
    "TransactionEnded",
    "query after explicit end must throw TransactionEnded",
  );
  assert.deepEqual(queries, ["BEGIN", "COMMIT"]);
  console.log(
    "PASS live PostgreSQL: query after explicit end throws typed TransactionEnded, with no later SQL.",
  );
} finally {
  await root.close({ graceful: true });
  await client.query("ROLLBACK");
  await client.end();
  await vite.close();
}
