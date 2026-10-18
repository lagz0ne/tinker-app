import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase, writeDispatch } from "./proof-write.mjs";

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

const { claimMailBatch, acknowledgeMail, deliverMailBatch, mailLeaseMs } = await vite.ssrLoadModule(
  "/tinker/components/mail/index.server.ts",
);

const { mail: alertMail } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");

const { database, leaseFrom } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const peer = new pg.Client({ connectionString });

const clients = [];

const roots = [];

const dispatch = writeDispatch();

const clock = makeTestClock({ now: Date.now() });

const schema = "lease_" + randomUUID().replaceAll("-", "");

const entered = Promise.withResolvers();

const released = Promise.withResolvers();

let sending;

try {
  await peer.connect();

  await peer.query(
    `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.mail_outbox (LIKE public.mail_outbox INCLUDING ALL)`,
  );

  await peer.query(`SET search_path TO ${schema},public`);

  for (let index = 0; index < 2; index++) {
    const client = new pg.Client({ connectionString });

    await client.connect();
    clients.push(client);
    client.on("error", () => {});

    await client.query(`SET search_path TO ${schema},public`);

    const root = createScope({
      clock,
      tags: [mailLeaseMs(1000)],
      presets: [
        preset(database, async () => writeDatabase(client, leaseFrom)),
        preset(alertMail, async () => ({
          send: async () => {
            entered.resolve();
            await released.promise;
          },
        })),
      ],
    });

    roots.push(root);
    await root.ready;
  }
  await peer.query(
    `INSERT INTO mail_outbox(id,"to",subject,text,dedupe_key,next_at) SELECT n,'proof@example.test','Lease','No SMTP',n::text,to_timestamp(0) FROM generate_series(1,21) n`,
  );

  const first = await Promise.all(roots.map((root) => dispatch.run(root, claimMailBatch)));

  assert.deepEqual(
    first.map((batch) => batch.rows.length).sort((a, b) => a - b),
    [1, 20],
    "mail claim must return disjoint batches of 20 and 1",
  );

  assert.equal(new Set(first.flatMap((batch) => batch.rows.map((row) => row.id))).size, 21);

  await peer.query("BEGIN");

  assert.equal(
    (await peer.query("SELECT id FROM mail_outbox FOR UPDATE NOWAIT")).rowCount,
    21,
    "committed claims must release every SQL lock",
  );

  await peer.query("ROLLBACK");

  assert.equal(
    (await dispatch.run(roots[1], claimMailBatch)).rows.length,
    0,
    "active leases must not be reclaimed",
  );

  clock.advance(1001);

  const renewed = await dispatch.run(roots[1], claimMailBatch);

  const old = first.find((batch) => batch.rows.some((row) => row.id === renewed.rows[0].id));

  assert.equal(
    (
      await dispatch.run(roots[1], acknowledgeMail, {
        input: { id: renewed.rows[0].id, token: old.token, error: null },
      })
    ).acknowledged,
    false,
    "old lease token must not acknowledge a new owner",
  );

  assert(
    renewed.rows.every((row) => row.attempts === 2),
    "lease recovery must preserve consumed attempts",
  );

  console.log(
    "PASS mail leases: disjoint 20/1 atomic claims; no locks after commit; active lease protected; expired lease reclaimed; stale ack refused.",
  );

  const pid = (await clients[0].query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

  await peer.query("SELECT pg_terminate_backend($1)", [pid]);

  clock.advance(1001);

  const recovered = await dispatch.run(roots[1], claimMailBatch);

  assert.equal(recovered.rows.length, 20, "claimant death must leave recoverable leases");

  const id = recovered.rows[0].id;

  await peer.query("UPDATE mail_outbox SET sent_at=now() WHERE id <> $1", [id]);

  await peer.query(
    "UPDATE mail_outbox SET attempts=11,lease_token=NULL,lease_until=NULL WHERE id=$1",
    [id],
  );

  const poison = await dispatch.run(roots[1], claimMailBatch);

  assert.equal(poison.rows[0].attempts, 12);

  await dispatch.run(roots[1], acknowledgeMail, {
    input: { id, token: poison.token, error: "refused" },
  });

  assert.equal(
    (await peer.query("SELECT dead_at IS NOT NULL AS dead FROM mail_outbox WHERE id=$1", [id]))
      .rows[0].dead,
    true,
    "exhausted mail must have durable dead-letter state",
  );

  clock.advance(86400000);

  assert.equal(
    (await dispatch.run(roots[1], claimMailBatch)).rows.length,
    0,
    "dead mail must not retry",
  );

  console.log(
    "PASS mail leases: claimant backend death retains attempts; recovery works; twelve attempts persist dead-letter state.",
  );

  await peer.query("UPDATE mail_outbox SET dead_at=NULL WHERE id=$1", [id]);
  await peer.query(
    `INSERT INTO mail_outbox(id,"to",subject,text,dedupe_key,next_at) VALUES(999,'proof@example.test','Fresh','No SMTP','fresh',to_timestamp(0))`,
  );
  await peer.query("BEGIN");
  await peer.query("SELECT id FROM mail_outbox WHERE id=$1 FOR UPDATE", [id]);
  try {
    const result = await dispatch.run(roots[1], claimMailBatch).then(
      (batch) => ({ status: "success", batch }),
      () => ({ status: "failed" }),
    );
    assert.equal(result.status, "success", "claim must skip locked exhausted rows");
    assert.deepEqual(
      result.batch.rows.map((row) => row.id),
      [999],
    );
  } finally {
    await peer.query("ROLLBACK");
  }
  await dispatch.run(roots[1], claimMailBatch);
  assert.equal(
    (await peer.query("SELECT dead_at IS NOT NULL AS dead FROM mail_outbox WHERE id=$1", [id]))
      .rows[0].dead,
    true,
  );
  await peer.query("UPDATE mail_outbox SET sent_at=now() WHERE id=999");
  console.log(
    "PASS mail leases: dead-letter cleanup skips a locked exhausted row; fresh mail still claims; cleanup resumes after unlock.",
  );

  await peer.query(
    "UPDATE mail_outbox SET attempts=0,sent_at=NULL,dead_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",
    [id],
  );

  sending = dispatch.run(roots[1], deliverMailBatch);

  const observed = Promise.allSettled([sending]);

  await Promise.race([entered.promise, sending]);

  await peer.query("BEGIN");

  try {
    await peer.query("SELECT id FROM mail_outbox WHERE id=$1 FOR UPDATE NOWAIT", [id]);
  } catch {
    assert.fail("mail send must not hold claim row locks");
  } finally {
    await peer.query("ROLLBACK");
  }
  released.resolve();

  assert.deepEqual(await sending, { claimed: 1, sent: 1, failed: 0 });

  await observed;

  console.log(
    "PASS mail leases: real delivery waits outside claim locks and acknowledges by token after send.",
  );
} finally {
  released.resolve();

  if (sending) await Promise.allSettled([sending]);

  await Promise.all(roots.map((root) => root.close()));

  await Promise.all(clients.map((client) => client.end().catch(() => {})));

  await peer.query("ROLLBACK");

  await peer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

  await peer.end();
  await vite.close();
}
