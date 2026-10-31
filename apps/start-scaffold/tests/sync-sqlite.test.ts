import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import { afterEach, expect, test } from "vite-plus/test";

import {
  database,
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseNotifyRetention,
  databasePollInterval,
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";
import {
  createAccountStream,
  eventHistory,
  notifications,
  publishAccountNotice,
} from "~/components/sync-sqlite/index.server";
import type { Sync } from "~/components/sync-sqlite/index.server";

import { write } from "./write-boundary";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A migrated temp database with the poll interval its proofs wait on. */
async function sandbox(poll = 40) {
  const home = await mkdtemp(join(tmpdir(), "tinker-sync-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(folder, name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  const root = createScope({
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      databasePollInterval(poll),
      databaseNotifyRetention(600_000),
    ],
  });

  await root.run(migrate);

  return root;
}

/** Wait until `ready` holds, or fail here instead of at the test timeout. */
async function until(ready: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (ready()) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`not ready after ${ms}ms`);
}

const paused = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One call's write: lock the stream, append the payloads, and end. */
function save(owner: string, executionId: string, payloads: Sync.Payload[]) {
  return operation({
    label: "proof.syncSave",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => {
      await history.lock(tx, owner);
      await history.append(tx, owner, executionId, payloads);

      return "saved";
    },
  });
}

/** The same write, refused after the append, so the call rolls back. */
function refuse(owner: string, executionId: string, payloads: Sync.Payload[]) {
  return operation({
    label: "proof.syncRefuse",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }, { raise }) => {
      await history.lock(tx, owner);
      await history.append(tx, owner, executionId, payloads);

      raise("StepRefused", {});
    },
  });
}

/** The real component's append, in a second OS process, through Vite's SSR loader. */
function spawnAppend(db: string, owner: string, executionId: string, change: unknown) {
  const child = spawn(process.execPath, ["tests/support/sqlite-child.mjs"], {
    cwd: app,
    env: {
      ...process.env,
      SQLITE_CHILD: JSON.stringify({ action: "append", db, owner, executionId, change }),
    },
  });

  let stderr = "";

  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise<void>((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}

test("an appended event wakes a same-process listener with the table name", async () => {
  const root = await sandbox(60_000);

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "start_sync",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  await write(root, save("public", crypto.randomUUID(), [{ kind: "change", change: 1 }]));
  await until(() => heard.length === 1);

  expect(heard).toEqual(["sync_event"]);

  stop();

  await root.close({ graceful: true });
});

test("an append that rolls back wakes nobody and leaves no rows", async () => {
  const root = await sandbox(40);

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "start_sync",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  await expect(
    write(root, refuse("public", crypto.randomUUID(), [{ kind: "change", change: 1 }])),
  ).rejects.toMatchObject({ kind: "StepRefused" });

  await paused(200);

  expect(heard).toEqual([]);
  expect(db.reader.prepare("SELECT * FROM sync_event").all()).toEqual([]);
  expect(db.reader.prepare("SELECT * FROM start_notify").all()).toEqual([]);

  stop();

  await root.close({ graceful: true });
});

test("a listener in another process hears an append through polling", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinker-sync-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(folder, name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  const file = join(home, "app.db");

  const root = createScope({
    tags: [
      databaseUrl(pathToFileURL(file)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      databasePollInterval(40),
      databaseNotifyRetention(600_000),
    ],
  });

  await root.run(migrate);
  await write(root, createAccountStream, { rawInput: { accountId: "public" } });

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "start_sync",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  await spawnAppend(file, "public", crypto.randomUUID(), { kind: "counter", value: 1 });
  await until(() => heard.length === 1);

  expect(heard).toEqual(["sync_event"]);

  stop();

  await root.close({ graceful: true });
});

test("publishAccountNotice delivers the account notice it names", async () => {
  const root = await sandbox(40);

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "start_sync",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  await write(root, publishAccountNotice, { rawInput: { accountId: "acct-1" } });
  await until(() => heard.length === 1);

  expect(heard).toEqual(["account:acct-1"]);

  stop();

  await root.close({ graceful: true });
});

test("history reads back the events it appended, in order and with their revisions", async () => {
  const root = await sandbox();

  const executionId = crypto.randomUUID();

  const first = { kind: "change", change: { kind: "counter", value: 1 } } as const;

  const second = { kind: "result", result: { ok: true } } as const;

  await write(root, save("public", executionId, [first, second]));

  const replay = operation({
    label: "proof.syncReplay",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => ({
      revision: await history.read(tx, "public"),
      events: await history.events(tx, "public", 0),
      receipt: await history.find(tx, executionId, "public"),
    }),
  });

  // pg's app inserts the receipt row when it accepts a write; this proof writes that row.
  const db = await root.resolve(database);

  db.client
    .prepare("INSERT INTO sync_execution (id, stream, notification, result) VALUES (?, ?, ?, ?)")
    .run(executionId, "public", null, JSON.stringify({ ok: true }));

  const result = await write(root, replay);

  expect(result.revision).toBe(2);
  expect(result.events).toEqual([
    { stream: "public", revision: 1, executionId, payload: first },
    { stream: "public", revision: 2, executionId, payload: second },
  ]);
  expect(result.receipt).toEqual({
    id: executionId,
    stream: "public",
    notification: null,
    result: { ok: true },
  });

  // A later append continues the same stream at the next revision.
  await write(root, save("public", crypto.randomUUID(), [{ kind: "change", change: 2 }]));

  const next = await write(root, replay);

  expect(next.events.map((entry) => entry.revision)).toEqual([1, 2, 3]);

  await root.close({ graceful: true });
});

test("the migrations seed the public stream at revision 0, as the Postgres set does", async () => {
  const root = await sandbox();

  const readPublic = operation({
    label: "proof.syncPublic",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => history.read(tx, "public"),
  });

  expect(await write(root, readPublic)).toBe(0);

  await root.close({ graceful: true });
});

test("a missing stream is refused, and another account's execution is denied", async () => {
  const root = await sandbox();

  const executionId = crypto.randomUUID();

  const db = await root.resolve(database);

  db.client
    .prepare("INSERT INTO sync_execution (id, stream) VALUES (?, ?)")
    .run(executionId, "public");

  const readMissing = operation({
    label: "proof.syncMissing",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => history.read(tx, "nobody"),
  });

  await expect(write(root, readMissing)).rejects.toMatchObject({ kind: "StreamMissing" });

  const readOther = operation({
    label: "proof.syncOther",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => history.find(tx, executionId, "someone-else"),
  });

  await expect(write(root, readOther)).rejects.toMatchObject({ kind: "StreamDenied" });

  await root.close({ graceful: true });
});

test("createAccountStream is idempotent", async () => {
  const root = await sandbox();

  await write(root, createAccountStream, { rawInput: { accountId: "acct-2" } });
  await write(root, createAccountStream, { rawInput: { accountId: "acct-2" } });

  const db = await root.resolve(database);

  expect(
    db.reader
      .prepare("SELECT id FROM sync_stream ORDER BY id")
      .all()
      .map((row) => row.id),
  ).toEqual(["acct-2", "public"]);

  await root.close({ graceful: true });
});

test("a notifications subscriber wakes on the append it waits for", async () => {
  const root = await sandbox(60_000);

  const watcher = await root.resolve(notifications);

  await write(root, save("public", crypto.randomUUID(), [{ kind: "change", change: 1 }]));

  const subscriber = await watcher.subscribe();

  try {
    const waiting = watcher.wait(subscriber, watcher.revision());

    expect(waiting).not.toBe(false);

    await write(root, save("public", crypto.randomUUID(), [{ kind: "change", change: 2 }]));

    expect(await waiting).toBe(false);
  } finally {
    watcher.close(subscriber);

    await root.close({ graceful: true });
  }
});
