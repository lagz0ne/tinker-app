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
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";
import { eventHistory } from "~/components/sync-sqlite/index.server";
import type { Sync } from "~/components/sync-sqlite/index.server";

import { write } from "./write-boundary";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A migrated temp database. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "tinker-history-sqlite-"));

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
    ],
  });

  await root.run(migrate);

  return root;
}

/** Lock the stream and append the payloads under one execution, in one session. */
function save(owner: string, executionId: string, payloads: Sync.Payload[]) {
  return operation({
    label: "proof.historySave",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => {
      await history.lock(tx, owner);
      await history.append(tx, owner, executionId, payloads);
    },
  });
}

function find(executionId: string, owner: string) {
  return operation({
    label: "proof.historyFind",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => history.find(tx, executionId, owner),
  });
}

test("an execution with no row reads back as missing", async () => {
  const root = await sandbox();

  expect(await write(root, find(crypto.randomUUID(), "public"))).toBeUndefined();

  await root.close({ graceful: true });
});

test("an append stores the result payload's value, and a change after it leaves that value", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  const executionId = crypto.randomUUID();

  db.client
    .prepare("INSERT INTO sync_execution (id, stream) VALUES (?, ?)")
    .run(executionId, "public");

  await write(
    root,
    save("public", executionId, [
      { kind: "result", result: { ok: true } },
      { kind: "change", change: { kind: "counter", value: 1 } },
    ]),
  );

  expect(await write(root, find(executionId, "public"))).toEqual({
    id: executionId,
    stream: "public",
    notification: null,
    result: { ok: true },
  });

  await root.close({ graceful: true });
});

test("an append with no result payload leaves the stored result empty", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  const executionId = crypto.randomUUID();

  db.client
    .prepare("INSERT INTO sync_execution (id, stream) VALUES (?, ?)")
    .run(executionId, "public");

  await write(root, save("public", executionId, [{ kind: "change", change: 1 }]));

  expect(
    db.reader.prepare("SELECT result FROM sync_execution WHERE id = ?").get(executionId),
  ).toEqual({ result: null });

  await root.close({ graceful: true });
});

test("an append to a stream that was never created is refused as missing", async () => {
  const root = await sandbox();

  const orphan = operation({
    label: "proof.historyOrphan",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) =>
      history.append(tx, "nobody", crypto.randomUUID(), [{ kind: "change", change: 1 }]),
  });

  await expect(write(root, orphan)).rejects.toMatchObject({ kind: "StreamMissing" });

  const db = await root.resolve(database);

  expect(db.reader.prepare("SELECT * FROM sync_event").all()).toEqual([]);

  await root.close({ graceful: true });
});
