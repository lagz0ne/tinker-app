import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope, operation } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase } from "./proof-write.mjs";

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
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

const url = "postgres://issue_board@127.0.0.1:15433/postgres";
const client = new pg.Client({ connectionString: url });
const peer = new pg.Client({ connectionString: url });
const schema = "sql_cancel_" + randomUUID().replaceAll("-", "");
const queries = [];

const checked = new Proxy(client, {
  get(target, key) {
    if (key !== "query") return Reflect.get(target, key, target);
    return (...args) => {
      queries.push(typeof args[0] === "string" ? args[0] : args[0].text);
      return target.query(...args);
    };
  },
});

let root;
let pending;
let timer;

try {
  await client.connect();

  await peer.connect();

  await peer.query(
    `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.blocked(id int PRIMARY KEY, value int); INSERT INTO ${schema}.blocked VALUES(1,0)`,
  );

  await peer.query(`BEGIN; UPDATE ${schema}.blocked SET value=1 WHERE id=1`);

  root = createScope({
    presets: [preset(database, async () => writeDatabase(checked, leaseFrom))],
  });

  await root.ready;

  const stop = new AbortController();

  const step = operation({
    label: "proof.blockedSQL",
    depends: { tx: transaction, orm: drizzleOrm },
    run: async ({ tx, orm }) =>
      tx.execute(orm.sql.raw(`UPDATE ${schema}.blocked SET value=2 WHERE id=1`)),
  });

  pending = root.controller(step).settle({ signal: stop.signal });

  const waiting = AbortSignal.timeout(3000);
  while (true) {
    waiting.throwIfAborted();
    await peer.query("SELECT pg_stat_clear_snapshot()");
    const lock = await peer.query(
      "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
      [client.processID],
    );
    if (lock.rowCount) break;
  }

  stop.abort(new Error("proof cancellation"));

  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("deadline"), 2000);
  });

  const result = await Promise.race([pending, deadline]);

  assert.notEqual(result, "deadline", "cancelled blocked SQL must finish rollback before deadline");

  assert.notEqual(result.status, "success", "a cancelled blocked write must not succeed");

  assert(stop.signal.aborted);

  assert.equal(
    queries.filter((query) => query === "ROLLBACK").length,
    1,
    "cancelled blocked SQL must issue exactly one ROLLBACK",
  );

  assert.equal(
    (await peer.query(`SELECT value FROM ${schema}.blocked`)).rows[0].value,
    1,
    "peer must still own its uncommitted lock",
  );

  console.log(
    "PASS live blocked SQL: cancellation joins exactly one rollback before deadline while the second connection still holds its lock.",
  );
} finally {
  clearTimeout(timer);

  await peer.query("ROLLBACK").catch(() => {});

  await pending;

  await root?.close({ graceful: true });

  await peer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

  await client.end();

  await peer.end();

  await vite.close();
}
