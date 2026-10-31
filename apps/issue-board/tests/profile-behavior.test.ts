import { createScope, type Observe } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { eq } from "drizzle-orm";
import { expect, test } from "vite-plus/test";

import { principal, user } from "~/components/auth/index.server";
import { database, migrate } from "~/components/database/index.server";
import { mail, type Mail } from "~/components/mail/index.server";
import { event, execution } from "~/components/sync/schema";

import { readProfile, retryNotification, saveProfile } from "@/demo/backend/profile.server";

import { proofDatabase } from "./presets";

const person = {
  id: "Ada",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const notification = { to: person.email, subject: "Saved", text: "Saved" };

test("retry refuses missing, incomplete, complete and foreign receipts without sending or writing a new receipt", async () => {
  const sends: unknown[] = [];
  const root = createScope({
    presets: [
      proofDatabase,
      preset(principal, async () => person),
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          sends.push(message);
        },
      })),
    ],
  });

  await root.ready;
  await root.run(migrate);
  const db = await root.resolve(database);
  for (const previous of [
    undefined,
    {
      notification: null,
      result: {
        kind: "partial",
        action: "profile",
        profileId: "Ada",
        notification: { kind: "failed", message: "retry" },
      },
    },
    { notification, result: null },
    { notification, result: { kind: "complete", action: "profile", profileId: "Ada" } },
    { notification, result: { kind: "failed", action: "profile", message: "failed" } },
    { notification, result: { bad: true } },
  ]) {
    const previousExecutionId = crypto.randomUUID();
    if (previous) {
      await db
        .insert(execution)
        .values({ id: previousExecutionId, stream: person.id, ...previous });
    }

    const executionId = crypto.randomUUID();
    const result = await root.settle(retryNotification, {
      input: { executionId, previousExecutionId },
    });
    expect(result).toMatchObject({
      status: "failed",
      error: { kind: "RetryNotAvailable", payload: {} },
    });
    expect(await db.select().from(execution).where(eq(execution.id, executionId))).toEqual([]);
  }

  const foreign = crypto.randomUUID();
  await db
    .insert(execution)
    .values({ id: foreign, stream: "Grace", notification, result: { kind: "partial" } });
  expect(
    await root.settle(retryNotification, {
      input: { executionId: crypto.randomUUID(), previousExecutionId: foreign },
    }),
  ).toMatchObject({ status: "failed", error: { kind: "StreamDenied", payload: {} } });
  expect(sends).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("saving for a removed account rolls back the receipt and change", async () => {
  const root = createScope({
    presets: [
      proofDatabase,
      preset(principal, async () => person),
      preset(mail, async () => ({ send: async () => expect.unreachable("no account, no mail") })),
    ],
  });

  await root.ready;
  await root.run(migrate);
  const id = crypto.randomUUID();
  expect(
    await root.settle(saveProfile, { input: { executionId: id, profile: { name: "New" } } }),
  ).toMatchObject({ status: "failed", error: { kind: "SignInRequired", payload: {} } });
  const db = await root.resolve(database);
  expect(await db.select().from(execution)).toEqual([]);
  expect(await db.select().from(event)).toEqual([]);
  expect(await root.run(readProfile)).toBeNull();
  await root.close({ graceful: true });
});

test("a bad name is refused as input before the receipt or the change is written", async () => {
  const root = createScope({
    presets: [
      proofDatabase,
      preset(principal, async () => person),
      preset(mail, async () => ({ send: async () => expect.unreachable("no name, no mail") })),
    ],
  });

  await root.ready;
  await root.run(migrate);
  const db = await root.resolve(database);
  await db.insert(user).values(person);
  for (const name of ["", "   ", "n".repeat(81)]) {
    expect(
      await root.settle(saveProfile, {
        input: { executionId: crypto.randomUUID(), profile: { name } },
      }),
    ).toMatchObject({
      status: "failed",
      error: { kind: "BadInput", payload: { reason: "Use a name with 1 to 80 letters." } },
    });
  }
  expect(await db.select().from(execution)).toEqual([]);
  expect(await db.select().from(event)).toEqual([]);
  expect(await root.run(readProfile)).toMatchObject({ name: "Ada" });
  await root.close({ graceful: true });
});

test("replaying a completed profile receipt changes no profile and sends no second mail", async () => {
  const messages: Mail.Message[] = [];
  const logs: Observe.Log[] = [];
  const root = createScope({
    observe: { log: (entry) => logs.push(entry) },
    presets: [
      proofDatabase,
      preset(principal, async () => person),
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          messages.push(message);
        },
      })),
    ],
  });

  await root.ready;
  await root.run(migrate);
  const db = await root.resolve(database);
  await db.insert(user).values(person);
  const id = crypto.randomUUID();
  const complete = { kind: "complete", action: "profile", profileId: person.id };
  await db.insert(execution).values({ id, stream: person.id, notification, result: complete });
  expect(
    await root.run(saveProfile, { input: { executionId: id, profile: { name: "Ignore" } } }),
  ).toEqual({ executionId: id });
  expect(
    await root.run(retryNotification, {
      input: { executionId: id, previousExecutionId: crypto.randomUUID() },
    }),
  ).toEqual({ executionId: id });
  expect(await root.run(readProfile)).toMatchObject({ name: "Ada" });
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(messages).toEqual([]);
  expect(logs.filter((entry) => entry.message === "profile.notification.failed")).toEqual([]);
});

test("a receipt without notification reports its failed background work with its receipt id", async () => {
  const logs: Observe.Log[] = [];
  const root = createScope({
    observe: { history: 30, log: (entry) => logs.push(entry) },
    presets: [
      proofDatabase,
      preset(principal, async () => person),
      preset(mail, async () => ({
        send: async () => expect.unreachable("receipt has no notification"),
      })),
    ],
  });

  await root.ready;
  await root.run(migrate);
  const db = await root.resolve(database);
  const id = crypto.randomUUID();
  await db.insert(execution).values({ id, stream: person.id });
  expect(
    await root.run(saveProfile, { input: { executionId: id, profile: { name: "Ignored" } } }),
  ).toEqual({ executionId: id });
  await root.close({ graceful: true });
  expect(root.spans().find((span) => span.name === "notifyProfile")?.error).toMatchObject({
    kind: "RetryNotAvailable",
    payload: {},
  });
  expect(logs.filter((entry) => entry.message === "profile.notification.failed")).toMatchObject([
    { level: 50, attributes: { executionId: id, status: "failed" } },
  ]);
});

test("another owner completing a held notification prevents a second result event", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const root = createScope({
    observe: {
      export: (span) => {
        if (span.name === "notifyProfile") finished.resolve();
      },
    },
    presets: [
      proofDatabase,
      preset(principal, async () => person),
      preset(mail, async () => ({
        send: async () => {
          started.resolve();
          await release.promise;
        },
      })),
    ],
  });

  await root.ready;
  await root.run(migrate);
  const db = await root.resolve(database);
  await db.insert(user).values(person);
  const id = crypto.randomUUID();
  await root.run(saveProfile, { input: { executionId: id, profile: { name: "Saved" } } });
  await started.promise;
  const result = { kind: "complete", action: "profile", profileId: person.id };
  await db.update(execution).set({ result }).where(eq(execution.id, id));
  release.resolve();
  await finished.promise;
  const rows = await db.select().from(event);
  expect(rows).toHaveLength(1);
  const closed = await root.close({ graceful: true });
  expect(closed.status).toBe("success");
  expect(closed.teardownErrors).toBeUndefined();
});
