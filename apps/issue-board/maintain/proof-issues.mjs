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
  cacheDir: ".tinker/proof-vite-cache",
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

const { database } = await vite.ssrLoadModule("/tinker/components/database/index.server.ts");

const dispatch = writeDispatch();

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const coordinator = new pg.Client({ connectionString });
const observer = new pg.Client({ connectionString });
const clients = [];
const roots = [];
const stop = new AbortController();
const teamId = randomUUID();
const prefix = `board-proof-${randomUUID()}`;
const ids = Array.from({ length: 20 }, () => randomUUID());
let writes = [];
let moves = [];

try {
  await coordinator.connect();
  await observer.connect();
  await coordinator.query("INSERT INTO team (id, key, name) VALUES ($1, $2, $3)", [
    teamId,
    prefix,
    "Concurrency proof",
  ]);
  for (const [index, id] of ids.entries()) {
    await coordinator.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `Proof ${index}`,
      `${id}@example.test`,
    ]);
    await coordinator.query(
      "INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, $3)",
      [teamId, id, "member"],
    );

    const client = new pg.Client({ connectionString, application_name: `${prefix}-${index}` });
    clients.push(client);
    await client.connect();
    client.on("error", (error) => console.error("worker connection:", error.message));

    const root = createScope({
      signal: stop.signal,
      presets: [
        preset(database, async () => writeDatabase(client)),
        preset(currentUser, async () => ({
          id,
          name: `Proof ${index}`,
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
  assert.equal(new Set(pids).size, 20);

  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM team WHERE id = $1 FOR UPDATE", [teamId]);
  writes = roots.map((root, index) =>
    dispatch.run(root, changeIssue, {
      rawInput: {
        executionId: randomUUID(),
        change: {
          kind: "create",
          teamId,
          title: `Concurrent ${index}`,
          description: "",
          state: "backlog",
          priority: 0,
          assigneeId: null,
        },
      },
    }),
  );
  // Attach rejection handlers while observing locks, so a failed writer is reported cleanly.
  const completed = Promise.allSettled(writes);
  const deadline = AbortSignal.timeout(30_000);
  let blocked = 0;
  while (blocked !== 20) {
    deadline.throwIfAborted();
    const result = await observer.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'
       AND (query LIKE '%"team"%' OR query LIKE '%"sync_stream"%')`,
      [pids],
    );
    blocked = result.rows[0].count;
  }
  await coordinator.query("COMMIT");
  const outcomes = await completed;
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }

  const rows = (
    await observer.query("SELECT id, number FROM issue WHERE team_id = $1 ORDER BY number", [
      teamId,
    ])
  ).rows;
  assert.deepEqual(
    rows.map((row) => row.number),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal(new Set(rows.map((row) => row.id)).size, 20);
  assert.equal(
    (await observer.query("SELECT issue_seq FROM team WHERE id = $1", [teamId])).rows[0].issue_seq,
    20,
  );
  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE", [
    [...ids].sort()[0],
  ]);
  moves = roots.slice(0, 2).map((root, index) =>
    dispatch.run(root, changeIssue, {
      rawInput: {
        executionId: randomUUID(),
        change: {
          kind: "move",
          teamId,
          id: rows[index].id,
          version: 1,
          state: "in_progress",
          beforeId: null,
        },
      },
    }),
  );
  const moved = Promise.allSettled(moves);
  const moveDeadline = AbortSignal.timeout(30_000);
  let moving = 0;
  while (moving !== 2) {
    moveDeadline.throwIfAborted();
    moving = (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE '%"sync_stream"%'`,
        [pids.slice(0, 2)],
      )
    ).rows[0].count;
  }
  assert.equal(
    (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_locks WHERE pid = ANY($1::int[]) AND relation = 'team'::regclass AND mode <> 'AccessShareLock'`,
        [pids.slice(0, 2)],
      )
    ).rows[0].count,
    0,
  );
  await coordinator.query("COMMIT");
  for (const outcome of await moved) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }
  const movedRows = (
    await observer.query("SELECT state, version, rank FROM issue WHERE id = ANY($1::uuid[])", [
      rows.slice(0, 2).map((row) => row.id),
    ])
  ).rows;
  assert.equal(movedRows.length, 2);
  assert(movedRows.every((row) => row.state === "in_progress" && row.version === 2));
  assert.equal(new Set(movedRows.map((row) => row.rank)).size, 2);
  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE", [
    [...ids].sort()[0],
  ]);
  const refusedIds = [randomUUID(), randomUUID()];
  moves = roots.slice(0, 2).map(async (root, index) =>
    dispatch.settle(root, changeIssue, {
      rawInput: {
        executionId: refusedIds[index],
        change: {
          kind: "move",
          teamId,
          id: rows[index].id,
          version: 2,
          state: "done",
          beforeId: null,
        },
      },
    }),
  );
  const membershipDeadline = AbortSignal.timeout(30_000);
  let waiting = 0;
  while (waiting !== 2) {
    membershipDeadline.throwIfAborted();
    waiting = (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE '%"sync_stream"%'`,
        [pids.slice(0, 2)],
      )
    ).rows[0].count;
  }
  const joined = randomUUID();
  ids.push(joined);
  await coordinator.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
    joined,
    "Joined during move",
    `${joined}@example.test`,
  ]);
  await coordinator.query(
    "INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')",
    [teamId, joined],
  );
  await coordinator.query("COMMIT");
  for (const outcome of await Promise.all(moves)) {
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.kind, "TeamChanged");
  }
  assert.equal(
    (
      await observer.query(
        "SELECT count(*)::int AS count FROM sync_execution WHERE id = ANY($1::text[])",
        [refusedIds],
      )
    ).rows[0].count,
    0,
  );
  assert(
    (
      await observer.query("SELECT state, version FROM issue WHERE id = ANY($1::uuid[])", [
        rows.slice(0, 2).map((row) => row.id),
      ])
    ).rows.every((row) => row.state === "in_progress" && row.version === 2),
  );
  console.log(
    "PASS live membership race: a member added while writers wait causes TeamChanged; no edits or executions commit with an incomplete stream-lock set.",
  );
  console.log(
    "PASS live Postgres moves: two members on separate connections wait on the first sorted member stream before taking any team row lock; both moves commit without deadlock; both versions 2; distinct fractional ranks.",
  );
  console.log(
    "PASS live Postgres: 20 separate connections; 20 concurrent writers observed blocked on sorted member streams / team row; numbers 1..20, no gaps or duplicates; 20 rows; counter 20.",
  );
} finally {
  await coordinator.query("ROLLBACK");
  await Promise.allSettled([...writes, ...moves]);
  stop.abort();
  await Promise.all(roots.map((root) => root.closed));
  await Promise.all(clients.map((client) => client.end()));

  await coordinator.query("DELETE FROM issue WHERE team_id = $1", [teamId]);
  await coordinator.query("DELETE FROM team_member WHERE team_id = $1", [teamId]);
  await coordinator.query("DELETE FROM team WHERE id = $1", [teamId]);
  await coordinator.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
  await coordinator.query("DELETE FROM sync_event WHERE stream = ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM sync_execution WHERE stream = ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM sync_stream WHERE id = ANY($1::text[])", [ids]);

  await coordinator.end();
  await observer.end();
  await vite.close();
}
