import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase, writeDispatch } from "./proof-write.mjs";

// Live scope proof: each writer owns a real connection and a distinct account stream.
const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
  cacheDir: ".tinker/proof-lock-vite-cache",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { changeIssue } = await vite.ssrLoadModule("/src/backend/issues.server.ts");
const { currentUser } = await vite.ssrLoadModule("/src/demo/backend/auth.server.ts");

const { database, leaseFrom } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const dispatch = writeDispatch();

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const coordinator = new pg.Client({ connectionString });
const observer = new pg.Client({ connectionString });
const prefix = `board-order-${randomUUID()}`;
const ids = [`${prefix}-a`, `${prefix}-z`];
const teams = [randomUUID(), randomUUID()];
const issues = [randomUUID(), randomUUID()];
const clients = [];
const roots = [];
const stop = new AbortController();
let moves = [];

try {
  await coordinator.connect();
  await observer.connect();
  for (const [index, id] of ids.entries()) {
    await coordinator.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `Order ${index}`,
      `${id}@example.test`,
    ]);
    await coordinator.query("INSERT INTO sync_stream (id) VALUES ($1)", [id]);
    await coordinator.query("INSERT INTO team (id, key, name) VALUES ($1, $2, $3)", [
      teams[index],
      `${prefix}-${index}`,
      "Opposite membership order",
    ]);
  }
  await coordinator.query(
    "INSERT INTO team_member (team_id, user_id, role) VALUES ($1,$3,'member'),($1,$4,'member'),($2,$4,'member'),($2,$3,'member')",
    [...teams, ...ids],
  );
  for (const [index, id] of ids.entries()) {
    await coordinator.query(
      "INSERT INTO issue (id, team_id, number, title, creator_id, rank) VALUES ($1,$2,1,'Move me',$3,'a0')",
      [issues[index], teams[index], id],
    );
    const client = new pg.Client({ connectionString, application_name: `${prefix}-${index}` });
    clients.push(client);
    await client.connect();
    // Force heap scans so removing ORDER BY exposes the opposite insert orders.
    await client.query(
      "SET enable_indexscan = off; SET enable_bitmapscan = off; SET lock_timeout = '5s'; SET statement_timeout = '10s'",
    );
    assert.deepEqual(
      (
        await client.query("SELECT user_id FROM team_member WHERE team_id = $1", [teams[index]])
      ).rows.map((row) => row.user_id),
      index === 0 ? ids : [...ids].reverse(),
    );

    const root = createScope({
      signal: stop.signal,
      presets: [
        preset(database, async () => writeDatabase(client, leaseFrom)),
        preset(currentUser, async () => ({
          id,
          name: `Order ${index}`,
          email: `${id}@example.test`,
        })),
      ],
    });
    roots.push(root);
    await root.ready;
  }
  const pids = await Promise.all(
    clients.map(
      async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    ),
  );
  assert.equal(new Set(pids).size, 2);

  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM issue WHERE id = ANY($1::uuid[]) FOR UPDATE", [issues]);
  await coordinator.query("SAVEPOINT stream_barrier");
  await coordinator.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE", [ids[0]]);
  moves = roots.map((root, index) =>
    dispatch.run(root, changeIssue, {
      rawInput: {
        executionId: randomUUID(),
        change: {
          kind: "move",
          teamId: teams[index],
          id: issues[index],
          version: 1,
          state: "in_progress",
          beforeId: null,
        },
      },
    }),
  );
  const outcomes = Promise.allSettled(moves);
  const deadline = AbortSignal.timeout(15_000);
  let blocked = 0;
  while (blocked !== 2) {
    deadline.throwIfAborted();
    blocked = (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE '%"sync_stream"%'`,
        [pids],
      )
    ).rows[0].count;
  }
  // With the sort removed, Y has locked z before waiting for a: NOWAIT fails.
  await observer.query("BEGIN");
  try {
    await observer.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE NOWAIT", [ids[1]]);
  } finally {
    await observer.query("ROLLBACK");
  }
  assert.equal(
    (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_locks WHERE pid = ANY($1::int[]) AND relation = 'team'::regclass AND mode <> 'AccessShareLock'`,
        [pids],
      )
    ).rows[0].count,
    0,
  );

  await coordinator.query("ROLLBACK TO SAVEPOINT stream_barrier");
  let writer;
  while (!writer) {
    deadline.throwIfAborted();
    writer = (
      await observer.query(
        `SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE 'update "issue"%'`,
        [pids],
      )
    ).rows[0];
  }
  await observer.query("BEGIN");
  try {
    // The real writer now holds its team row. NO KEY UPDATE must allow FK checks.
    await observer.query("SELECT id FROM team WHERE id = $1 FOR KEY SHARE NOWAIT", [
      teams[pids.indexOf(writer.pid)],
    ]);
  } finally {
    await observer.query("ROLLBACK");
  }
  await coordinator.query("COMMIT");
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }
  const saved = (
    await observer.query("SELECT state, version FROM issue WHERE id = ANY($1::uuid[])", [issues])
  ).rows;
  assert.equal(saved.length, 2);
  assert(saved.every((row) => row.state === "in_progress" && row.version === 2));
  console.log(
    "PASS cross-team lock order: opposite heap member orders; both stop on a, z stays free; no team write lock before streams; both moves commit without deadlock.",
  );
  console.log(
    "PASS team NO KEY UPDATE: a real writer holds the team row while blocked on its issue; FOR KEY SHARE NOWAIT succeeds.",
  );
} finally {
  await coordinator.query("ROLLBACK");
  await Promise.allSettled(moves);
  stop.abort();
  await Promise.all(roots.map((root) => root.closed));
  await Promise.all(clients.map((client) => client.end()));

  await coordinator.query("DELETE FROM issue WHERE team_id = ANY($1::uuid[])", [teams]);
  await coordinator.query("DELETE FROM team_member WHERE team_id = ANY($1::uuid[])", [teams]);
  await coordinator.query("DELETE FROM team WHERE id = ANY($1::uuid[])", [teams]);
  await coordinator.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
  await coordinator.query("DELETE FROM sync_event WHERE stream = ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM sync_execution WHERE stream = ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM sync_stream WHERE id = ANY($1::text[])", [ids]);
  await coordinator.end();
  await observer.end();
  await vite.close();
}
