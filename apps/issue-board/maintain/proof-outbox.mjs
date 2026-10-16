import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import nodemailer from "nodemailer";
import pg from "pg";
import { createServer } from "vite-plus";

const vite = await createServer({
  configFile: false,
  cacheDir: ".tinker/proof-outbox-vite-cache",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { deliverMailBatch, outboxWake } = await vite.ssrLoadModule("/src/backend/outbox.server.ts");

const { database, databaseUrl } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const { mail } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");
const connectionString = "postgres://issue_board@127.0.0.1:15433/postgres";
// Intentionally fixed to the local Mailpit. No external SMTP is allowed in a proof.
const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 11026, secure: false });
const coordinator = new pg.Client({ connectionString });
const observer = new pg.Client({ connectionString });
const prefix = `outbox-proof-${randomUUID()}`;
const clients = [];
const roots = [];
const entered = [Promise.withResolvers(), Promise.withResolvers()];
const release = Promise.withResolvers();
const stop = new AbortController();
let batches = [];
let wakeRoot;

try {
  await coordinator.connect();
  await observer.connect();
  await coordinator.query(
    "INSERT INTO mail_outbox (\"to\", subject, text, dedupe_key) SELECT 'proof@example.test', $1, 'Local batch proof', $1 || ':' || n FROM generate_series(1,21) n",
    [prefix],
  );
  for (let index = 0; index < 2; index += 1) {
    const client = new pg.Client({ connectionString });
    clients.push(client);
    await client.connect();
    await client.query("SET lock_timeout='5s'; SET statement_timeout='10s'");

    const root = createScope({
      signal: stop.signal,
      presets: [
        preset(database, async () => drizzle({ client })),
        preset(mail, async () => ({
          send: async (message) => {
            entered[index].resolve();
            await release.promise;
            await smtp.sendMail({ from: "board@example.test", ...message });
          },
        })),
      ],
    });
    roots.push(root);
    await root.ready;
  }
  // Keep unrelated demo alerts out of this isolated claim proof without discarding them.
  await coordinator.query("BEGIN");
  await coordinator.query(
    "SELECT id FROM mail_outbox WHERE sent_at IS NULL AND dedupe_key NOT LIKE $1 FOR UPDATE",
    [`${prefix}%`],
  );
  batches = [roots[0].run(deliverMailBatch)];
  const outcomes = [];
  outcomes.push(Promise.allSettled(batches));
  await Promise.race([entered[0].promise, batches[0]]);
  batches.push(roots[1].run(deliverMailBatch));
  outcomes.push(Promise.allSettled([batches[1]]));
  await Promise.race([entered[1].promise, batches[1]]);
  const pids = (
    await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND query LIKE '%skip locked%' ",
    )
  ).rows;
  assert.equal(pids.length, 2);
  await observer.query("BEGIN");
  const unclaimed = await observer.query(
    "SELECT id FROM mail_outbox WHERE sent_at IS NULL AND next_at <= now() FOR UPDATE SKIP LOCKED",
  );
  assert.equal(unclaimed.rows.length, 0);
  await observer.query("ROLLBACK");
  release.resolve();
  const done = await Promise.all(batches);
  await Promise.all(outcomes);
  assert.deepEqual(
    done.map((row) => row.claimed).sort((a, b) => a - b),
    [1, 20],
  );
  assert(done.every((row) => row.sent === row.claimed && row.failed === 0));
  assert.equal(
    (
      await observer.query(
        "SELECT count(*)::int AS count FROM mail_outbox WHERE dedupe_key LIKE $1 AND sent_at IS NOT NULL AND attempts=1",
        [`${prefix}%`],
      )
    ).rows[0].count,
    21,
  );
  await coordinator.query("ROLLBACK");
  console.log(
    "PASS live SKIP LOCKED: two separate connections hold disjoint batches of 20 and 1 at the SMTP barrier; zero unlocked due rows; all 21 sent once to local Mailpit.",
  );

  const clock = makeTestClock();
  const listenerUrl = new URL(connectionString);
  listenerUrl.searchParams.set("application_name", prefix);
  wakeRoot = createScope({
    signal: stop.signal,
    clock,
    tags: [databaseUrl(listenerUrl)],
  });
  await wakeRoot.ready;
  const wake = await wakeRoot.resolve(outboxWake);
  await wake.listen();
  const woke = wake.wait();
  await coordinator.query("BEGIN");
  await coordinator.query(
    "INSERT INTO mail_outbox (\"to\",subject,text,dedupe_key) VALUES ('proof@example.test',$1,'Rollback',$2)",
    [prefix, `${prefix}:rollback`],
  );
  await coordinator.query("ROLLBACK");
  assert.equal(
    (
      await observer.query("SELECT count(*)::int AS count FROM mail_outbox WHERE dedupe_key=$1", [
        `${prefix}:rollback`,
      ])
    ).rows[0].count,
    0,
  );
  await coordinator.query(
    "INSERT INTO mail_outbox (\"to\",subject,text,dedupe_key) VALUES ('proof@example.test',$1,'Wake',$2)",
    [prefix, `${prefix}:wake`],
  );
  await woke;
  let polled = false;
  const poll = wake.wait().then(() => {
    polled = true;
  });
  clock.advance(29_999);
  await Promise.resolve();
  assert.equal(polled, false);
  clock.advance(1);
  await poll;
  assert.equal(polled, true);
  console.log(
    "PASS outbox poll: real listener plus test clock; no notification; wait stays pending at 29,999 ms and wakes at 30,000 ms.",
  );
  const listener = (
    await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query='LISTEN board_outbox'",
      [prefix],
    )
  ).rows;
  assert.equal(listener.length, 1);
  const disconnected = wake.wait();
  await observer.query("SELECT pg_terminate_backend($1)", [listener[0].pid]);
  await disconnected;
  await wake.listen();
  const reconnected = wake.wait();
  await coordinator.query("SELECT pg_notify('board_outbox', '')");
  await reconnected;
  console.log(
    "PASS listener reconnect: terminate only the proof listener PID; wake returns, LISTEN reconnects, and a new notification wakes it again.",
  );
  const mailpit = await (
    await fetch(
      `http://127.0.0.1:18026/api/v1/search?query=${encodeURIComponent(`subject:${prefix}`)}&limit=100`,
    )
  ).json();
  assert.equal(mailpit.messages.length, 21);
  console.log(
    "PASS live outbox wake: LISTEN board_outbox wakes after committed insert; rolled-back insert leaves no row; Mailpit confirms 21 messages.",
  );
} finally {
  release.resolve();
  await coordinator.query("ROLLBACK");
  await Promise.allSettled(batches);
  stop.abort();
  await Promise.all(roots.map((root) => root.closed));
  if (wakeRoot) await wakeRoot.closed;
  await Promise.all(clients.map((client) => client.end()));

  await coordinator.query("DELETE FROM mail_outbox WHERE dedupe_key LIKE $1", [`${prefix}%`]);
  await coordinator.end();
  await observer.end();
  smtp.close();
  await vite.close();
}
