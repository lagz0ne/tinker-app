import { createScope, type Scope } from "@tinker/core";
import { preset, makeTestClock, type Clock } from "@tinker/core/testing";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { user } from "~/components/auth/index.server";
import { database, migrate, drizzleOrm } from "~/components/database/index.server";
import { mail, type Mail } from "~/components/mail/index.server";

import { team, teamMember, mailOutbox } from "@/backend/board.schema.server";
import { addComment } from "@/backend/comments.server";
import { changeIssue } from "@/backend/issues.server";
import { deliverMailBatch } from "@/backend/outbox.server";
import { currentUser } from "@/demo/backend/auth.server";
import { bootstrapPrivate } from "@/demo/backend/sync.server";

import { proofDatabase } from "./presets";

let root: Scope.RootHandle;
let clock: Clock.Test;
let stop: AbortController;
let teamId: string;
let refuse: boolean;
let sent: { to: string; subject: string; text: string }[];

const draft = {
  kind: "create",
  title: "Mail alert",
  description: "",
  state: "backlog",
  priority: 0,
  assigneeId: null,
};

beforeEach(async () => {
  stop = new AbortController();
  clock = makeTestClock({ now: Date.parse("2030-01-01T00:00:00.000Z") });
  refuse = false;
  sent = [];
  teamId = crypto.randomUUID();
  root = createScope({
    signal: stop.signal,
    clock,
    presets: [
      proofDatabase,
      preset(currentUser, async () => ({
        id: "author",
        name: "Author",
        email: "author@example.test",
      })),
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          if (refuse) throw new Error("local SMTP refused");
          sent.push(message);
        },
      })),
    ],
  });

  await root.ready;
  await root.run(migrate);

  const db = await root.resolve(database);
  await db
    .insert(user)
    .values(
      ["author", "member", "outsider"].map((id) => ({ id, name: id, email: `${id}@example.test` })),
    );
  await db.insert(team).values({ id: teamId, key: "ENG", name: "Engineering" });
  await db.insert(teamMember).values([
    { teamId, userId: "author", role: "admin" },
    { teamId, userId: "member", role: "member" },
  ]);
});

afterEach(async () => {
  stop.abort();
  expect((await root.closed).status).toBe("success");
});

test("issue and comment alerts commit once, only for other team members", async () => {
  const command = { executionId: crypto.randomUUID(), change: { ...draft, teamId } };
  await root.run(changeIssue, { rawInput: command });
  await root.run(changeIssue, { rawInput: command });

  const snapshot = await root.run(bootstrapPrivate);
  const comment = {
    executionId: crypto.randomUUID(),
    comment: { teamId, issueId: snapshot.issues[0]!.id, body: "Ready to read" },
  };
  await root.run(addComment, { rawInput: comment });
  await root.run(addComment, { rawInput: comment });

  const db = await root.resolve(database);
  const rows = await db.select().from(mailOutbox);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.to)).toEqual(["member@example.test", "member@example.test"]);
  expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
  expect(rows.map((row) => row.subject)).toEqual(["ENG-1: Mail alert", "New comment on ENG-1"]);
  expect(sent).toEqual([]);
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 2, sent: 2, failed: 0 });
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 0, sent: 0, failed: 0 });
  expect(sent).toHaveLength(2);
  expect(
    (await db.select().from(mailOutbox)).every((row) => row.sentAt !== null && row.attempts === 1),
  ).toBe(true);
});

test("a failed saved event rolls back the alert with the issue or comment", async () => {
  await root.run(changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, teamId } },
  });

  const db = await root.resolve(database);
  const before = await db.select().from(mailOutbox);

  const snapshot = await root.run(bootstrapPrivate);
  const { sql } = await root.resolve(drizzleOrm);
  await db.execute(
    sql`CREATE FUNCTION refuse_alert_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'event refused'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER refuse_alert_event BEFORE INSERT ON sync_event FOR EACH ROW EXECUTE FUNCTION refuse_alert_event()`,
  );

  const comment = await root.settle(addComment, {
    rawInput: {
      executionId: crypto.randomUUID(),
      comment: { teamId, issueId: snapshot.issues[0]!.id, body: "Must roll back" },
    },
  });
  const issue = await root.settle(changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, teamId } },
  });
  expect(comment.status).toBe("failed");
  expect(issue.status).toBe("failed");
  expect(await db.select().from(mailOutbox)).toEqual(before);
});

test("worker retries with exponential backoff and leaves future mail alone", async () => {
  const db = await root.resolve(database);
  await db
    .insert(mailOutbox)
    .values({ to: "member@example.test", subject: "Retry", text: "Local only", dedupeKey: "retry" })
    .returning();

  refuse = true;
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 1 });
  const [first] = await db.select().from(mailOutbox);
  expect(first).toMatchObject({
    attempts: 1,
    sentAt: null,
    lastError: "Error: local SMTP refused",
  });
  expect(first!.nextAt.getTime()).toBe(clock.currentTimeMillis() + 1000);
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 0, sent: 0, failed: 0 });
  clock.advance(1000);
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 1 });
  const [second] = await db.select().from(mailOutbox);
  expect(second!.attempts).toBe(2);
  // The next failure doubles the one-second retry delay.
  expect(second!.nextAt.getTime()).toBe(clock.currentTimeMillis() + 2000);

  refuse = false;
  clock.advance(2000);
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 1, sent: 1, failed: 0 });
  expect((await db.select().from(mailOutbox))[0]).toMatchObject({ attempts: 3, lastError: null });
  expect(sent).toHaveLength(1);
});

test("a batch is limited to twenty and dedupe keys reject duplicate rows", async () => {
  const db = await root.resolve(database);
  await db.insert(mailOutbox).values(
    Array.from({ length: 21 }, (_, index) => ({
      to: "member@example.test",
      subject: "Batch",
      text: "Local only",
      dedupeKey: `batch:${index}`,
    })),
  );
  await expect(
    db.insert(mailOutbox).values({
      to: "member@example.test",
      subject: "Again",
      text: "No repeat",
      dedupeKey: "batch:0",
    }),
  ).rejects.toMatchObject({ cause: { code: "23505" } });

  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 20, sent: 20, failed: 0 });
  expect(await root.run(deliverMailBatch)).toEqual({ claimed: 1, sent: 1, failed: 0 });
  expect(sent).toHaveLength(21);
});
