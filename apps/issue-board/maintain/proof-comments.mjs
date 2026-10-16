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
  cacheDir: ".tinker/proof-comments-vite-cache",
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

const { addComment } = await vite.ssrLoadModule("/src/backend/comments.server.ts");
const { bootstrapPrivate } = await vite.ssrLoadModule("/src/demo/backend/sync.server.ts");
const coordinator = new pg.Client({ connectionString });
const observer = new pg.Client({ connectionString });
const prefix = `board-comments-${randomUUID()}`;
const ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-outsider`];
const teamId = randomUUID();
const issueId = randomUUID();
const clients = [];
const roots = [];
const stop = new AbortController();
let writes = [];

try {
  await coordinator.connect();
  await observer.connect();
  for (const [index, id] of ids.entries()) {
    await coordinator.query('INSERT INTO "user" (id, name, email) VALUES ($1,$2,$3)', [
      id,
      `Comment ${index}`,
      `${id}@example.test`,
    ]);
    await coordinator.query("INSERT INTO sync_stream (id) VALUES ($1)", [id]);
  }
  await coordinator.query("INSERT INTO team (id, key, name) VALUES ($1,$2,'Comments proof')", [
    teamId,
    prefix,
  ]);
  await coordinator.query(
    "INSERT INTO team_member (team_id, user_id, role) VALUES ($1,$3,'member'),($1,$2,'member')",
    [teamId, ids[0], ids[1]],
  );
  await coordinator.query(
    "INSERT INTO issue (id, team_id, number, title, creator_id, rank) VALUES ($1,$2,1,'Discuss me',$3,'a0')",
    [issueId, teamId, ids[0]],
  );

  // The fourth connection is a second real transaction for actor A's retry.
  for (const [index, id] of [...ids, ids[0]].entries()) {
    const client = new pg.Client({ connectionString, application_name: `${prefix}-${index}` });
    clients.push(client);
    await client.connect();
    // Expose the deliberately reversed insertion order instead of using the primary key.
    await client.query("SET enable_indexscan = off; SET enable_bitmapscan = off");
    assert.deepEqual(
      (await client.query("SELECT user_id FROM team_member WHERE team_id = $1", [teamId])).rows.map(
        (row) => row.user_id,
      ),
      [ids[1], ids[0]],
    );
    await client.query("SET lock_timeout = '5s'; SET statement_timeout = '10s'");

    const root = createScope({
      signal: stop.signal,
      presets: [
        preset(database, async () => writeDatabase(client, leaseFrom)),
        preset(currentUser, async () => ({
          id,
          name: `Comment ${index}`,
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
  assert.equal(new Set(pids).size, 4);

  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE", [ids[0]]);
  const executions = [randomUUID(), randomUUID()];
  writes = roots.slice(0, 2).map((root, index) =>
    dispatch.run(root, addComment, {
      rawInput: {
        executionId: executions[index],
        comment: { teamId, issueId, body: `Concurrent comment ${index}` },
      },
    }),
  );
  const completed = Promise.allSettled(writes);
  const deadline = AbortSignal.timeout(15_000);
  let blocked = 0;
  while (blocked !== 2) {
    deadline.throwIfAborted();
    blocked = (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE '%"sync_stream"%'`,
        [pids.slice(0, 2)],
      )
    ).rows[0].count;
  }
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
        [pids.slice(0, 2)],
      )
    ).rows[0].count,
    0,
  );
  await coordinator.query("COMMIT");
  for (const outcome of await completed) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }
  assert.equal(
    (
      await observer.query("SELECT count(*)::int AS count FROM comment WHERE issue_id = $1", [
        issueId,
      ])
    ).rows[0].count,
    2,
  );

  const retry = {
    executionId: randomUUID(),
    comment: { teamId, issueId, body: "Exactly once under concurrent retry" },
  };
  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE", [ids[0]]);
  writes = [
    dispatch.run(roots[0], addComment, { rawInput: retry }),
    dispatch.run(roots[3], addComment, { rawInput: retry }),
  ];
  const retries = Promise.allSettled(writes);
  const retryDeadline = AbortSignal.timeout(15_000);
  let retryBlocked = 0;
  while (retryBlocked !== 2) {
    retryDeadline.throwIfAborted();
    retryBlocked = (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE '%"sync_stream"%'`,
        [[pids[0], pids[3]]],
      )
    ).rows[0].count;
  }
  console.log("PASS retry barrier: both separate backend PIDs wait on sync_stream before release.");
  await coordinator.query("COMMIT");
  for (const outcome of await retries) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }
  assert.equal(
    (
      await observer.query("SELECT count(*)::int AS count FROM comment WHERE issue_id = $1", [
        issueId,
      ])
    ).rows[0].count,
    3,
  );
  assert.equal(
    (
      await observer.query(
        'SELECT count(*)::int AS count FROM sync_event WHERE "executionId" = $1',
        [retry.executionId],
      )
    ).rows[0].count,
    3,
  );

  await coordinator.query("BEGIN");
  await coordinator.query("SELECT id FROM sync_stream WHERE id = $1 FOR UPDATE", [ids[0]]);
  writes = [
    dispatch.run(roots[0], addComment, {
      rawInput: {
        executionId: randomUUID(),
        comment: { teamId, issueId, body: "Comment alongside a move" },
      },
    }),
    dispatch.run(roots[1], changeIssue, {
      rawInput: {
        executionId: randomUUID(),
        change: {
          kind: "move",
          teamId,
          id: issueId,
          version: 1,
          state: "in_progress",
          beforeId: null,
        },
      },
    }),
  ];
  const mixed = Promise.allSettled(writes);
  const mixedDeadline = AbortSignal.timeout(15_000);
  let moving = 0;
  while (moving !== 2) {
    mixedDeadline.throwIfAborted();
    moving = (
      await observer.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND query LIKE '%"sync_stream"%'`,
        [pids.slice(0, 2)],
      )
    ).rows[0].count;
  }
  await coordinator.query("COMMIT");
  for (const outcome of await mixed) {
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  }
  const member = await roots[1].run(bootstrapPrivate);
  const outsider = await roots[2].run(bootstrapPrivate);
  assert.equal(member.comments.length, 4);
  assert.equal(new Set(member.comments.map((row) => row.id)).size, 4);
  assert.equal(member.issues[0].version, 2);
  assert.deepEqual(outsider.comments, []);
  const refusal = await dispatch.settle(roots[2], addComment, {
    rawInput: { executionId: randomUUID(), comment: { teamId, issueId, body: "Not allowed" } },
  });
  assert.equal(refusal.status, "failed");
  assert.equal(refusal.error.kind, "NotTeamMember");

  const events = (
    await observer.query(
      "SELECT stream, payload FROM sync_event WHERE stream = ANY($1::text[]) OR (stream = 'public' AND payload->'change'->>'kind' = 'comment.add')",
      [ids],
    )
  ).rows;
  assert.equal(events.filter((row) => row.stream === ids[2]).length, 0);
  const additions = events.filter(
    (row) => row.payload.kind === "change" && row.payload.change.kind === "comment.add",
  );
  assert.equal(additions.length, 8);
  for (const row of member.comments) {
    const copies = additions.filter((event) => event.payload.change.comment.id === row.id);
    assert.equal(copies.length, 2);
    assert.deepEqual(
      copies.map((event) => event.stream).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ids.slice(0, 2),
    );
    assert.deepEqual(copies[0].payload, copies[1].payload);
  }
  const results = (
    await observer.query(
      `SELECT e.stream, x.stream AS owner FROM sync_event e JOIN sync_execution x ON e."executionId" = x.id WHERE e.stream = ANY($1::text[]) AND e.payload->>'kind' = 'result'`,
      [ids],
    )
  ).rows;
  assert.equal(results.length, 5);
  assert(results.every((row) => row.stream === row.owner));
  console.log(
    "PASS live comments: two concurrent member comments; sorted stream locks before team; both commit. Concurrent same-execution retry on two separate connections creates one comment and three events.",
  );
  console.log(
    "PASS live comment/move: both commit without deadlock; four comments, identical per-member row changes, actor-only results; non-member reads zero comments and has zero stream events; add is NotTeamMember.",
  );
} finally {
  await coordinator.query("ROLLBACK");
  await Promise.allSettled(writes);
  stop.abort();
  await Promise.all(roots.map((root) => root.closed));
  await Promise.all(clients.map((client) => client.end()));

  await coordinator.query("DELETE FROM issue WHERE id = $1", [issueId]);
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
