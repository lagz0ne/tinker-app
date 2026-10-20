import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";

const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
  server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "~": fileURLToPath(new URL("../tinker", import.meta.url)) } },
});

const { database, databaseUrl } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const peer = new pg.Client({ connectionString });

const url = new URL(connectionString);

const name = "channel_" + randomUUID();
url.searchParams.set("application_name", name);

const root = createScope({ tags: [databaseUrl(url)] });

let close;

try {
  await peer.connect();
  await root.ready;

  const db = await root.resolve(database);

  const dropped = Promise.withResolvers();

  let woke = Promise.withResolvers();

  let count = 0;

  const received = () => {
    count++;
    woke.resolve();
  };

  close = await db.listen("board_outbox", received, () => dropped.resolve());

  const listening = (
    await peer.query("SELECT pid,query FROM pg_stat_activity WHERE application_name=$1", [name])
  ).rows;

  assert.equal(listening.length, 1);

  assert.equal(
    listening[0].query,
    "LISTEN board_outbox",
    "database listener must subscribe to requested channel",
  );

  await peer.query("BEGIN");
  await peer.query("SELECT pg_notify('board_outbox','rollback')");
  await peer.query("ROLLBACK");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 0, "rollback must not publish wake");

  await peer.query("SELECT pg_notify('board_outbox','commit')");
  await woke.promise;
  assert.equal(count, 1);

  await peer.query("SELECT pg_terminate_backend($1)", [listening[0].pid]);
  await dropped.promise;

  await close();
  woke = Promise.withResolvers();

  close = await db.listen("board_outbox", received, () => {});

  const connected = (
    await peer.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1", [name])
  ).rows;

  assert.notEqual(connected[0].pid, listening[0].pid);

  await peer.query("SELECT pg_notify('board_outbox','reconnect')");
  await woke.promise;
  assert.equal(count, 2);

  console.log(
    "PASS database channel: requested board_outbox, rollback silent, committed wake, backend PID drop, new listener receives next wake.",
  );
} finally {
  await close?.();
  await root.close();
  await peer.end();
  await vite.close();
}
