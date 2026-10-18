import { createScope, type Scope } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import { beforeEach, afterEach, expect, test } from "vite-plus/test";

import { database, migrate } from "~/components/database/index.server";
import {
  mail,
  mailOutbox,
  claimMailBatch,
  acknowledgeMail,
  releaseMailClaims,
  deliverMailBatch,
  mailWorkerStop,
  mailLeaseMs,
  runMailWorker,
  outboxWake,
} from "~/components/mail/index.server";

import { proofDatabase, databaseQueries } from "./presets";
import { write } from "./write-boundary";

let root: Scope.Handle;

let clock: ReturnType<typeof makeTestClock>;

let stop: AbortController;

let refuse: boolean;

let sends: number;
let senderAction: (() => Promise<void>) | undefined;

beforeEach(async () => {
  stop = new AbortController();

  clock = makeTestClock({ now: Date.parse("2030-01-01T00:00:00Z") });

  refuse = false;

  sends = 0;
  senderAction = undefined;

  root = createScope({
    clock,
    tags: [mailWorkerStop(stop.signal), mailLeaseMs(120000)],
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async () => {
          sends++;
          await senderAction?.();
          if (refuse) throw new Error("refused");
        },
      })),
    ],
  });

  await root.ready;

  await root.run(migrate);

  await (await root.resolve(database)).insert(mailOutbox).values({
    to: "proof@example.test",
    subject: "Mail",
    text: "Body",
    dedupeKey: "one",
    nextAt: new Date(0),
  });
});

afterEach(async () => {
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("lease expiry and token fencing preserve crash attempts; release refunds unsent claims", async () => {
  databaseQueries.length = 0;
  const first = await write(root, claimMailBatch);
  expect(
    databaseQueries.filter((query) => /\bupdate\b/i.test(query)),
    "one claim must use one SQL statement",
  ).toHaveLength(1);

  expect(first.rows).toHaveLength(1);

  expect(first.rows[0]).toMatchObject({ attempts: 1, leaseToken: first.token });

  expect(first.rows[0]!.leaseUntil!.getTime()).toBe(clock.currentTimeMillis() + 120000);

  expect((await write(root, claimMailBatch)).rows).toEqual([]);

  clock.advance(119999);

  expect((await write(root, claimMailBatch)).rows).toEqual([]);

  clock.advance(1);

  const second = await write(root, claimMailBatch);

  expect(second.rows[0]!.attempts).toBe(2);

  expect(second.token).not.toBe(first.token);

  expect(
    await write(root, acknowledgeMail, {
      input: { id: first.rows[0]!.id, token: first.token, error: null },
    }),
  ).toEqual({ acknowledged: false });

  await write(root, releaseMailClaims, { input: { token: second.token } });

  const third = await write(root, claimMailBatch);

  expect(third.rows[0]!.attempts).toBe(2);
});

test("delivery persists exponential retry and success without holding send locks", async () => {
  refuse = true;

  expect(await write(root, deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 1 });

  const db = await root.resolve(database);

  let [row] = await db.select().from(mailOutbox);

  expect(row).toMatchObject({
    attempts: 1,
    sentAt: null,
    lastError: "Error: refused",
    leaseToken: null,
    deadAt: null,
  });

  expect(row!.nextAt.getTime()).toBe(clock.currentTimeMillis() + 1000);

  expect(await write(root, deliverMailBatch)).toEqual({ claimed: 0, sent: 0, failed: 0 });

  clock.advance(1000);

  await write(root, deliverMailBatch);

  [row] = await db.select().from(mailOutbox);

  expect(row!.nextAt.getTime()).toBe(clock.currentTimeMillis() + 2000);

  clock.advance(2000);

  refuse = false;

  expect(await write(root, deliverMailBatch)).toEqual({ claimed: 1, sent: 1, failed: 0 });

  [row] = await db.select().from(mailOutbox);

  expect(row).toMatchObject({ attempts: 3, lastError: null, leaseToken: null, deadAt: null });

  expect(row!.sentAt!.getTime()).toBe(clock.currentTimeMillis());

  expect(sends).toBe(3);
});

test("a full claim contains twenty and another caller gets only the remaining row", async () => {
  const db = await root.resolve(database);

  await db.insert(mailOutbox).values(
    Array.from({ length: 20 }, (_, i) => ({
      to: "proof@example.test",
      subject: "Batch",
      text: "Body",
      dedupeKey: "batch:" + i,
      nextAt: new Date(0),
    })),
  );

  const first = await write(root, claimMailBatch);

  const second = await write(root, claimMailBatch);

  expect(first.rows).toHaveLength(20);

  expect(second.rows).toHaveLength(1);

  expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(21);
});

test("failed twelfth send becomes dead; crash at twelfth claim also becomes dead", async () => {
  const db = await root.resolve(database);

  await db.execute(sql`UPDATE mail_outbox SET attempts=11`);

  refuse = true;

  expect(await write(root, deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 1 });

  expect((await db.select().from(mailOutbox))[0]).toMatchObject({
    attempts: 12,
    deadAt: new Date(clock.currentTimeMillis()),
  });

  expect((await write(root, claimMailBatch)).rows).toEqual([]);

  await db.execute(sql`UPDATE mail_outbox SET attempts=11,dead_at=NULL,next_at=to_timestamp(0)`);

  expect((await write(root, claimMailBatch)).rows[0]!.attempts).toBe(12);

  clock.advance(120000);

  expect((await write(root, claimMailBatch)).rows).toEqual([]);

  expect((await db.select().from(mailOutbox))[0]).toMatchObject({
    attempts: 12,
    leaseToken: null,
    leaseUntil: null,
    deadAt: new Date(clock.currentTimeMillis()),
  });
});

test("dead-letter cleanup is bounded to twenty rows per claim", async () => {
  const db = await root.resolve(database);

  await db.insert(mailOutbox).values(
    Array.from({ length: 20 }, (_, index) => ({
      to: "proof@example.test",
      subject: "Dead",
      text: "Body",
      dedupeKey: "dead:" + index,
      nextAt: new Date(0),
    })),
  );

  await db.execute(sql`UPDATE mail_outbox SET attempts=12`);

  expect((await write(root, claimMailBatch)).rows).toEqual([]);

  expect((await db.select().from(mailOutbox)).filter((row) => row.deadAt)).toHaveLength(20);

  await write(root, claimMailBatch);

  expect((await db.select().from(mailOutbox)).every((row) => row.deadAt)).toBe(true);
});

test("future rows stay untouched and send stops before a second leased row", async () => {
  const db = await root.resolve(database);

  await db.insert(mailOutbox).values({
    to: "proof@example.test",
    subject: "Future",
    text: "Body",
    dedupeKey: "future",
    nextAt: new Date(clock.currentTimeMillis() + 1000),
  });

  stop.abort();

  expect(await write(root, deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 0 });

  const rows = await db.select().from(mailOutbox);

  expect(rows.find((row) => row.dedupeKey === "one")).toMatchObject({
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    sentAt: null,
  });

  expect(rows.find((row) => row.dedupeKey === "future")).toMatchObject({
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    sentAt: null,
  });

  expect(sends).toBe(0);
});

test("mail worker drains batches, reconnects, waits and stops without a hidden loop", async () => {
  let attempts = 0;

  let batches = 0;

  let retries = 0;

  const stopping = new AbortController();

  const worker = createScope({
    tags: [mailWorkerStop(stopping.signal)],
    presets: [
      preset(outboxWake, async () => ({
        listen: async () => {
          if (++attempts < 3) throw new Error("reconnect");
        },
        retry: async () => {
          retries++;
        },
        wait: async () => {
          stopping.abort();
        },
      })),
      preset(deliverMailBatch, async () => ({
        claimed: ++batches === 1 ? 20 : 1,
        sent: 0,
        failed: 0,
      })),
    ],
  });

  try {
    await worker.ready;
    await worker.run(runMailWorker, { signal: new AbortController().signal });
    expect({ attempts, retries, batches }).toEqual({ attempts: 3, retries: 2, batches: 2 });
  } finally {
    expect((await worker.close({ graceful: true })).status).toBe("success");
  }
});

test("a batch leaves room for send plus acknowledgement before starting SMTP", async () => {
  const db = await root.resolve(database);

  await db.insert(mailOutbox).values({
    to: "proof@example.test",
    subject: "Second",
    text: "Body",
    dedupeKey: "second",
    nextAt: new Date(0),
  });

  senderAction = async () => {
    clock.advance(109001);
  };

  expect(
    await write(root, deliverMailBatch),
    "remaining lease must cover send plus acknowledgement",
  ).toEqual({ claimed: 2, sent: 1, failed: 0 });

  expect(sends).toBe(1);

  const recovered = await write(root, claimMailBatch);

  expect(recovered.rows).toHaveLength(1);

  expect(recovered.rows[0]).toMatchObject({ attempts: 1, sentAt: null });
});

test("a lease shorter than the twenty-send budget is rejected", () => {
  expect(() => mailLeaseMs(119999)).toThrow();
});
