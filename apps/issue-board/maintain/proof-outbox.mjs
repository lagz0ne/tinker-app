import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import nodemailer from "nodemailer";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase, writeDispatch } from "./proof-write.mjs";

const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
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

const { deliverMailBatch, outboxWake } = await vite.ssrLoadModule(
  "/tinker/components/mail/index.server.ts",
);

const { database, databaseUrl, leaseFrom } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const dispatch = writeDispatch();

const { mail: alertMail } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");
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
const crashEntered = Promise.withResolvers();
const crashRelease = Promise.withResolvers();
const clientErrors = [];
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
    client.on("error", (error) => clientErrors.push(error));
    await client.connect();
    await client.query("SET lock_timeout='5s'; SET statement_timeout='10s'");

    const root = createScope({
      signal: stop.signal,
      presets: [
        preset(database, async () => writeDatabase(client, leaseFrom)),
        preset(alertMail, async () => ({
          send: async (message) => {
            if (index === 0 && message.text === "Crash recovery") {
              crashEntered.resolve();
              await crashRelease.promise;
              throw new Error("worker database connection was killed before SMTP");
            }
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
  batches = [dispatch.run(roots[0], deliverMailBatch)];
  const outcomes = [];
  outcomes.push(Promise.allSettled(batches));
  await Promise.race([entered[0].promise, batches[0]]);
  batches.push(dispatch.run(roots[1], deliverMailBatch));
  outcomes.push(Promise.allSettled([batches[1]]));
  await Promise.race([entered[1].promise, batches[1]]);
  const pids = (
    await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND query LIKE '%skip locked%' ",
    )
  ).rows;
  assert.equal(pids.length, 0, "SMTP must not keep a transaction open");
  await observer.query("BEGIN");
  const unclaimed = await observer.query(
    "SELECT id FROM mail_outbox WHERE dedupe_key LIKE $1 FOR UPDATE NOWAIT",
    [`${prefix}%`],
  );
  assert.equal(unclaimed.rows.length, 21, "committed batch leases must not hold row locks");
  await observer.query("ROLLBACK");
  release.resolve();
  const done = await Promise.all(batches);
  await Promise.all(outcomes);
  assert.deepEqual(
    done.map((row) => row.claimed).sort((a, b) => a - b),
    [1, 20],
    "outbox claim must return batches of 20 and 1",
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
    "PASS live SKIP LOCKED: two separate connections lease disjoint batches of 20 and 1 at the SMTP barrier; all 21 rows unlocked; all 21 sent once to local Mailpit.",
  );

  await coordinator.query("BEGIN");
  await coordinator.query(
    "SELECT id FROM mail_outbox WHERE sent_at IS NULL AND dedupe_key NOT LIKE $1 FOR UPDATE",
    [`${prefix}%`],
  );
  await observer.query(
    `INSERT INTO mail_outbox ("to",subject,text,dedupe_key) VALUES ('proof@example.test',$1,'Crash recovery',$2)`,
    [prefix, `${prefix}:crash`],
  );
  const crashedPid = (await clients[0].query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const crashed = dispatch.settle(roots[0], deliverMailBatch);
  await crashEntered.promise;
  await observer.query("SELECT pg_terminate_backend($1)", [crashedPid]);
  crashRelease.resolve();
  assert.equal((await crashed).status, "failed");
  assert(clientErrors.length > 0);
  const unsent = (
    await observer.query("SELECT sent_at, attempts FROM mail_outbox WHERE dedupe_key=$1", [
      `${prefix}:crash`,
    ])
  ).rows[0];
  assert.equal(unsent.sent_at, null);
  assert.equal(unsent.attempts, 1);
  await observer.query(
    "UPDATE mail_outbox SET lease_until=now()-interval '1 second' WHERE dedupe_key=$1",
    [`${prefix}:crash`],
  );
  assert.deepEqual(await dispatch.run(roots[1], deliverMailBatch), {
    claimed: 1,
    dead: 0,
    sent: 1,
    failed: 0,
  });
  await coordinator.query("ROLLBACK");
  console.log(
    "PASS crash recovery: killed the claiming worker backend PID before SMTP; claim committed with attempts=1; expired lease recovers; another worker claims and sends its row once to local Mailpit.",
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
  const beforePid = (
    await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query='LISTEN board_outbox'",
      [prefix],
    )
  ).rows[0].pid;
  let notified = false;
  const woke = wake.wait().then(() => {
    notified = true;
  });
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, false, "rollback must not wake the listener");
  await coordinator.query(
    "INSERT INTO mail_outbox (\"to\",subject,text,dedupe_key) VALUES ('proof@example.test',$1,'Wake',$2)",
    [prefix, `${prefix}:wake`],
  );
  await woke;
  const afterPid = (
    await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query='LISTEN board_outbox'",
      [prefix],
    )
  ).rows[0].pid;
  assert.equal(afterPid, beforePid, "wake must be a notification, not a dropped listener");
  let polled = false;
  const poll = wake.wait().then(() => {
    polled = true;
  });
  clock.advance(29_999);
  await new Promise((resolve) => setImmediate(resolve));
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
  assert.equal(mailpit.messages.length, 22);
  console.log(
    "PASS live outbox wake: LISTEN board_outbox wakes after committed insert; rolled-back insert leaves no row; Mailpit confirms 22 messages (21 batch + 1 crash recovery).",
  );
} finally {
  release.resolve();
  crashRelease.resolve();
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
