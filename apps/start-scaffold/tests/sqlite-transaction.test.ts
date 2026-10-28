import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A scope over a fresh temp database, already migrated and ready for writes. */
async function sandbox(extra: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  await writeFile(join(folder, "20261028000000_start_notify.sql"), await migrationText());

  for (const [index, text] of extra.entries()) {
    await writeFile(join(folder, `2026102800000${index + 1}_extra.sql`), text);
  }

  const root = createScope({
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
    ],
  });

  await root.run(migrate);

  return root;
}

/** The shipped migration, read from the app so the proof uses the real table. */
function migrationText() {
  return readFile(join(app, "sqlite/migrations/20261028000000_start_notify.sql"), "utf8");
}

async function payloads(root: Awaited<ReturnType<typeof sandbox>>) {
  const db = await root.resolve(database);

  return db.reader
    .prepare("SELECT payload FROM start_notify ORDER BY id")
    .all()
    .map((row) => String(row.payload));
}

test("a committed session persists its notify row and a raised step persists none", async () => {
  const root = await sandbox();

  const save = operation({
    label: "proof.sqliteSave",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof", "kept");

      return "saved";
    },
  });

  const refused = operation({
    label: "proof.sqliteRefused",
    depends: { tx: transaction },
    run: async ({ tx }, { raise }) => {
      await tx.notify("proof", "dropped");

      raise("StepRefused", {});
    },
  });

  expect(await root.settle(save, { signal: new AbortController().signal })).toMatchObject({
    status: "success",
  });
  expect(await root.settle(refused, { signal: new AbortController().signal })).toMatchObject({
    status: "failed",
    error: { kind: "StepRefused" },
  });

  expect(await payloads(root)).toEqual(["kept"]);

  await root.close({ graceful: true });
});

test("a COMMIT the database refuses fails the call and leaves no row", async () => {
  const root = await sandbox([
    "create table proof_parent (id integer primary key);\ncreate table proof_child (parent_id integer references proof_parent (id))",
  ]);

  const save = operation({
    label: "proof.sqliteDeferred",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      const connection = await tx.db();

      connection.exec("PRAGMA defer_foreign_keys = ON");
      connection.prepare("INSERT INTO proof_child (parent_id) VALUES (?)").run(99);

      return "saved";
    },
  });

  await expect(root.settle(save, { signal: new AbortController().signal })).resolves.toMatchObject({
    status: "failed",
    error: { kind: "TeardownFailed" },
  });

  const db = await root.resolve(database);

  expect(db.client.prepare("SELECT * FROM proof_child").all()).toEqual([]);

  await root.close({ graceful: true });
});

test("an ended session refuses work with TransactionEnded, after one end only", async () => {
  const root = await sandbox();

  for (const end of ["commit", "rollback"] as const) {
    const after = operation({
      label: `proof.sqliteAfter${end}`,
      depends: { tx: transaction },
      run: async ({ tx }) => {
        await tx.notify("proof", "before");

        await tx[end]();
        await tx[end]();

        await tx.notify("proof", "after");
      },
    });

    const result = await root.settle(after, { signal: new AbortController().signal });

    expect(result).toMatchObject({ status: "failed", error: { kind: "TransactionEnded" } });
  }

  // The committed session kept its row; the rolled-back one kept none; neither kept "after".
  expect(await payloads(root)).toEqual(["before"]);

  await root.close({ graceful: true });
});

test("the connection an ended session handed out refuses its own queries", async () => {
  const root = await sandbox();

  const refused: string[] = [];

  const call = operation({
    label: "proof.sqliteEndedView",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      const connection = await tx.db();

      await tx.commit();

      // A held connection is the view the ended session exported, not the raw connection.
      try {
        connection.prepare("SELECT 1").get();
      } catch (error) {
        refused.push(String((error as Error & { kind?: string }).kind));
      }

      try {
        connection.exec("SELECT 1");
      } catch (error) {
        refused.push(String((error as Error & { kind?: string }).kind));
      }

      return "done";
    },
  });

  expect(await root.settle(call, { signal: new AbortController().signal })).toMatchObject({
    status: "success",
    value: "done",
  });
  expect(refused).toEqual(["TransactionEnded", "TransactionEnded"]);

  await root.close({ graceful: true });
});

test("a nested transaction is refused before it can take a second turn", async () => {
  const root = await sandbox();

  const nested = operation({
    label: "proof.sqliteNested",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof", "outer");

      tx.transaction();
    },
  });

  expect(await root.settle(nested, { signal: new AbortController().signal })).toMatchObject({
    status: "failed",
    error: { kind: "NestedTransaction" },
  });
  expect(await payloads(root)).toEqual([]);

  await root.close({ graceful: true });
});

test("two sessions in one process never interleave their statements", async () => {
  const root = await sandbox();

  const inside = Promise.withResolvers<void>();

  const gate = Promise.withResolvers<void>();

  const save = operation({
    label: "proof.sqliteFirst",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof", "a1");

      inside.resolve();

      await gate.promise;

      await tx.notify("proof", "a2");
    },
  });

  const other = operation({
    label: "proof.sqliteSecond",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof", "b1");
    },
  });

  const signal = new AbortController().signal;

  const first = root.settle(save, { signal });

  await inside.promise;

  const second = root.settle(other, { signal });

  // The second session waits while the first holds the one write turn.
  await new Promise((resolve) => setTimeout(resolve, 100));
  gate.resolve();

  expect(await first).toMatchObject({ status: "success" });
  expect(await second).toMatchObject({ status: "success" });

  expect(await payloads(root)).toEqual(["a1", "a2", "b1"]);

  await root.close({ graceful: true });
});

test("a call cancelled while it waits for the write turn leaves the queue", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  const release = await db.writeTurn();

  const save = operation({
    label: "proof.sqliteWaiting",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof", "waiting");
    },
  });

  const stop = new AbortController();

  const running = root.settle(save, { signal: stop.signal });

  await new Promise((resolve) => setTimeout(resolve, 100));
  stop.abort();

  const settled = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 2000)),
  ]);

  // The turn was never granted, so the call stops without waiting for its holder.
  expect(settled).toMatchObject({ status: "cancelled" });
  expect(await payloads(root)).toEqual([]);

  release();

  const late = operation({
    label: "proof.sqliteAfterCancel",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof", "late");
    },
  });

  expect(await root.settle(late, { signal: new AbortController().signal })).toMatchObject({
    status: "success",
  });
  expect(await payloads(root)).toEqual(["late"]);

  await root.close({ graceful: true });
});

test("an aborted waiter leaves the queue only after the turn ahead of it ends", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  // The test holds the process's write turn, as a live session would.
  const release = await db.writeTurn();

  const save = (payload: string) =>
    operation({
      label: `proof.sqlite${payload}`,
      depends: { tx: transaction },
      run: async ({ tx }) => {
        await tx.notify("proof", payload);
      },
    });

  const second = new AbortController();

  const waitingSecond = root.settle(save("b"), { signal: second.signal });

  const waitingThird = root.settle(save("c"), { signal: new AbortController().signal });

  await new Promise((resolve) => setTimeout(resolve, 50));
  second.abort();

  expect(await waitingSecond).toMatchObject({ status: "cancelled" });

  // The third waiter sits behind the aborted one, so it must not open a transaction yet.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await payloads(root)).toEqual([]);

  release();

  expect(await waitingThird).toMatchObject({ status: "success" });
  expect(await payloads(root)).toEqual(["c"]);

  await root.close({ graceful: true });
});

test("taking the write turn takes its abort listener off the caller", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  const stop = new AbortController();

  const release = await db.writeTurn(stop.signal);

  expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);

  release();

  await root.close({ graceful: true });
});

test("a call that never writes takes no write turn", async () => {
  const root = await sandbox();

  const readOnly = operation({
    label: "proof.sqliteReadOnly",
    depends: { tx: transaction },
    run: async () => "read",
  });

  const db = await root.resolve(database);

  const release = await db.writeTurn();

  try {
    const settled = await Promise.race([
      root.settle(readOnly, { signal: new AbortController().signal }),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);

    expect(settled).toMatchObject({ status: "success", value: "read" });
  } finally {
    release();

    await root.close({ graceful: true });
  }
});
