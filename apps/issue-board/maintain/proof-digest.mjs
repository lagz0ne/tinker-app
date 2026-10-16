import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createServer } from "vite-plus";

const vite = await createServer({
  configFile: false,
  cacheDir: ".tinker/proof-digest-vite-cache",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { queueDailyDigests, digestDone } = await vite.ssrLoadModule("/src/backend/digest.server.ts");

const { database, databaseUrl } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const { outboxWake } = await vite.ssrLoadModule("/src/backend/outbox.server.ts");
const prefix = `digest-proof-${randomUUID()}`;
const connectionString = "postgres://issue_board@127.0.0.1:15433/postgres";
const coordinator = new pg.Client({ connectionString });
const observer = new pg.Client({ connectionString });
const clients = [];
const roots = [];
const stop = new AbortController();
const ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-outsider`];
const teamId = randomUUID();
const issueId = randomUUID();
const clock = makeTestClock({ now: Date.parse("2030-05-06T09:00:00Z") });
let writes = [];
let wakeRoot;
let priorKeys = [];

try {
  await coordinator.connect();
  await observer.connect();
  priorKeys = (
    await coordinator.query(
      "SELECT dedupe_key FROM mail_outbox WHERE dedupe_key LIKE 'digest:%:2030-05-06'",
    )
  ).rows.map((row) => row.dedupe_key);
  for (const id of ids) {
    await coordinator.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [
      id,
      `${id}@example.test`,
    ]);
  }
  await coordinator.query("INSERT INTO team (id,key,name) VALUES ($1,$2,'Digest proof')", [
    teamId,
    prefix,
  ]);
  await coordinator.query(
    "INSERT INTO team_member (team_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')",
    [teamId, ids[0], ids[1]],
  );
  await coordinator.query(
    "INSERT INTO issue (id,team_id,number,title,creator_id,rank) VALUES ($1,$2,1,'Digest race',$3,'a0')",
    [issueId, teamId, ids[0]],
  );
  for (let index = 0; index < 2; index += 1) {
    const client = new pg.Client({ connectionString, application_name: `${prefix}-${index}` });
    clients.push(client);
    await client.connect();
    await client.query("SET lock_timeout='10s'; SET statement_timeout='15s'");

    const root = createScope({
      signal: stop.signal,
      clock,
      presets: [preset(database, async () => drizzle({ client }))],
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
  // Keep the first insert invisible so the second must wait on its unique key.
  await clients[0].query("BEGIN");
  const first = await roots[0].run(queueDailyDigests);
  assert(first.queued >= 2);
  const second = roots[1].run(queueDailyDigests);
  writes = [second];
  const settled = Promise.allSettled(writes);
  const deadline = AbortSignal.timeout(10_000);
  let blocked = false;
  while (!blocked) {
    deadline.throwIfAborted();
    blocked = (
      await observer.query(
        "SELECT wait_event FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
        [pids[1]],
      )
    ).rows.some((row) => row.wait_event === "transactionid");
  }
  await clients[0].query("COMMIT");
  const results = await settled;
  assert.equal(results[0].status, "fulfilled", JSON.stringify(results));
  assert.equal(results[0].value.queued, 0);
  const receipts = (
    await observer.query(
      "SELECT * FROM mail_outbox WHERE dedupe_key=ANY($1::text[]) ORDER BY dedupe_key",
      [ids.map((id) => `digest:${id}:2030-05-06`)],
    )
  ).rows;
  assert.equal(receipts.length, 2);
  assert.deepEqual(
    receipts.map((row) => row.to).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ids.slice(0, 2).map((id) => `${id}@example.test`),
  );
  assert(receipts.every((row) => row.text.includes("Digest race")));
  const replay = await roots[1].run(queueDailyDigests);
  assert.equal(replay.queued, 0);
  console.log(
    "PASS live digest race: second INSERT waits on transactionid until first commits; second queues 0; one durable digest per member/day, zero outsider receipts; replay queues zero.",
  );

  wakeRoot = createScope({
    signal: stop.signal,
    clock,
    tags: [databaseUrl(new URL(connectionString))],
  });
  await wakeRoot.ready;
  const wake = await wakeRoot.resolve(outboxWake);
  await wake.listen();
  let emptyNotices = 0;
  observer.on("notification", () => {
    emptyNotices += 1;
  });
  await observer.query("LISTEN board_outbox");
  let woke = false;
  const pending = wake.wait().then(() => {
    woke = true;
  });
  (await roots[1].resolve(digestDone)).day = "";
  await roots[1].run(queueDailyDigests);
  await observer.query("SELECT 1");
  assert.equal(emptyNotices, 0, "zero-row insert must emit no notification");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(woke, false, "a zero-row digest tick must not notify itself");
  clock.advance(30_000);
  await pending;
  console.log(
    "PASS digest idle tick: zero-row insert emits no board_outbox wake; healthy 30s poll remains pending until its deadline.",
  );

  await observer.query("SET enable_seqscan=off");
  const plan = (
    await observer.query(
      "EXPLAIN SELECT id FROM mail_outbox WHERE sent_at IS NULL AND attempts < $1 AND next_at <= $2 ORDER BY next_at,id LIMIT 20 FOR UPDATE SKIP LOCKED",
      [12, new Date()],
    )
  ).rows
    .map((row) => row["QUERY PLAN"])
    .join("\n");
  assert(plan.includes("mail_outbox_due"), plan);
  const predicate = (
    await observer.query(
      "SELECT pg_get_expr(indpred,indrelid) AS predicate FROM pg_index WHERE indexrelid='mail_outbox_due'::regclass",
    )
  ).rows[0].predicate;
  assert(predicate.includes("attempts < 12"), predicate);
  console.log(
    "PASS live claim index: parameterized claim shape can use mail_outbox_due; partial predicate excludes sent and attempts>=12 rows.",
  );
  console.log(plan);
} finally {
  await clients[0]?.query("ROLLBACK");
  await Promise.allSettled(writes);
  await coordinator.query("ROLLBACK");
  stop.abort();
  await Promise.all(roots.map((root) => root.closed));
  if (wakeRoot) await wakeRoot.closed;
  await Promise.all(clients.map((client) => client.end()));

  await coordinator.query(
    "DELETE FROM mail_outbox WHERE dedupe_key LIKE 'digest:%:2030-05-06' AND NOT (dedupe_key=ANY($1::text[]))",
    [priorKeys],
  );
  await coordinator.query("DELETE FROM issue WHERE id=$1", [issueId]);
  await coordinator.query("DELETE FROM team_member WHERE team_id=$1", [teamId]);
  await coordinator.query("DELETE FROM team WHERE id=$1", [teamId]);
  await coordinator.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
  await coordinator.end();
  await observer.end();
  await vite.close();
}
