import { createScope, type Scope } from "@tinker/core";
import { makeTestClock, type Clock } from "@tinker/core/testing";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { user } from "~/components/auth/index.server";
import { database, migrate, drizzleOrm } from "~/components/database/index.server";

import { issue, mailOutbox, team, teamMember } from "@/backend/board.schema.server";
import { queueDailyDigests } from "@/backend/digest.server";

import { proofDatabase, databaseQueries } from "./presets";

let root: Scope.RootHandle;
let stop: AbortController;
let clock: Clock.Test;
let eng: string;
let ops: string;

beforeEach(async () => {
  stop = new AbortController();
  clock = makeTestClock({ now: Date.parse("2030-01-01T08:59:59.999Z") });
  root = createScope({ signal: stop.signal, clock, presets: [proofDatabase] });
  await root.ready;
  await root.run(migrate);

  const db = await root.resolve(database);
  eng = crypto.randomUUID();
  ops = crypto.randomUUID();
  await db
    .insert(user)
    .values(
      ["ada", "grace", "outsider"].map((id) => ({ id, name: id, email: `${id}@example.test` })),
    );
  await db.insert(team).values([
    { id: eng, key: "ENG", name: "Engineering" },
    { id: ops, key: "OPS", name: "Operations" },
  ]);
  await db.insert(teamMember).values([
    { teamId: eng, userId: "ada", role: "admin" },
    { teamId: eng, userId: "grace", role: "member" },
    { teamId: ops, userId: "ada", role: "admin" },
  ]);
  await db.insert(issue).values([
    {
      id: crypto.randomUUID(),
      teamId: eng,
      number: 1,
      title: "Fix login",
      creatorId: "ada",
      rank: "a0",
    },
    {
      id: crypto.randomUUID(),
      teamId: eng,
      number: 2,
      title: "Already done",
      state: "done",
      creatorId: "ada",
      rank: "a0",
    },
    {
      id: crypto.randomUUID(),
      teamId: ops,
      number: 1,
      title: "Private OPS",
      creatorId: "ada",
      rank: "a0",
    },
  ]);
});

afterEach(async () => {
  stop.abort();
  expect((await root.closed).status).toBe("success");
});

test("UTC tick queues once per member per day and keeps each user's visible open issues", async () => {
  const db = await root.resolve(database);
  const { eq } = await root.resolve(drizzleOrm);
  databaseQueries.length = 0;
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });
  expect(databaseQueries).toEqual([]);
  clock.advance(1);
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 2 });
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });
  expect(databaseQueries).toHaveLength(1);

  const rows = await db.select().from(mailOutbox);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.dedupeKey).sort()).toEqual([
    "digest:ada:2030-01-01",
    "digest:grace:2030-01-01",
  ]);
  const ada = rows.find((row) => row.to === "ada@example.test")!;
  const grace = rows.find((row) => row.to === "grace@example.test")!;
  expect(ada.text).toBe(
    "Open issues for 2030-01-01 (UTC)\n\nENG-1 · Fix login [backlog], priority 0\nOPS-1 · Private OPS [backlog], priority 0",
  );
  expect(grace.text).toBe(
    "Open issues for 2030-01-01 (UTC)\n\nENG-1 · Fix login [backlog], priority 0",
  );
  expect(rows.every((row) => !row.text.includes("Already done"))).toBe(true);
  expect(rows.every((row) => row.to !== "outsider@example.test")).toBe(true);
  await db
    .update(mailOutbox)
    .set({ attempts: 12, lastError: "dead" })
    .where(eq(mailOutbox.id, ada.id));
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });

  clock.advance(86_400_000);
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 2 });
  expect(await db.select().from(mailOutbox)).toHaveLength(4);
});

test("a late restart catches up today without backfilling missed days; empty boards send nothing", async () => {
  clock.setTime(Date.parse("2030-02-03T23:59:59.999Z"));
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 2 });
  clock.advance(1);
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });

  const db = await root.resolve(database);
  const { eq } = await root.resolve(drizzleOrm);
  await db.update(issue).set({ state: "canceled" }).where(eq(issue.teamId, eng));
  await db.update(issue).set({ state: "done" }).where(eq(issue.teamId, ops));
  clock.setTime(Date.parse("2030-02-04T09:00:00Z"));
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });
  expect((await db.select().from(mailOutbox)).map((row) => row.dedupeKey).sort()).toEqual([
    "digest:ada:2030-02-03",
    "digest:grace:2030-02-03",
  ]);
});

test("the claim index excludes sent rows and dead rows", async () => {
  const db = await root.resolve(database);
  const { sql } = await root.resolve(drizzleOrm);
  const indexes = await db.execute(
    sql`SELECT indexdef FROM pg_indexes WHERE indexname='mail_outbox_due'`,
  );
  expect(indexes).toMatchObject({ rows: [{ indexdef: expect.stringContaining("attempts < 12") }] });
  expect(indexes).toMatchObject({
    rows: [{ indexdef: expect.stringContaining("sent_at IS NULL") }],
  });
});

test("a member joining after the daily snapshot waits until tomorrow", async () => {
  clock.advance(1);
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 2 });
  const db = await root.resolve(database);

  await db.insert(teamMember).values({ teamId: eng, userId: "outsider", role: "member" });

  clock.setTime(Date.parse("2030-01-01T10:00:00Z"));
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 0 });
  expect(
    (await db.select().from(mailOutbox)).some((row) => row.to === "outsider@example.test"),
  ).toBe(false);

  clock.setTime(Date.parse("2030-01-02T09:00:00Z"));
  expect(await root.run(queueDailyDigests)).toEqual({ queued: 3 });
});

test("digest text lists at most fifty issues and reports the rest", async () => {
  const db = await root.resolve(database);

  await db.insert(issue).values(
    Array.from({ length: 51 }, (_, index) => ({
      id: crypto.randomUUID(),
      teamId: eng,
      number: index + 3,
      title: "Extra issue",
      creatorId: "ada",
      rank: "a0",
    })),
  );

  clock.advance(1);
  await root.run(queueDailyDigests);
  const rows = await db.select().from(mailOutbox);
  const grace = rows.find((row) => row.to === "grace@example.test")!;
  expect(grace.text.split("\n").filter((line) => line.startsWith("ENG-"))).toHaveLength(50);
  expect(grace.text).toContain("And 2 more open issues.");
});
