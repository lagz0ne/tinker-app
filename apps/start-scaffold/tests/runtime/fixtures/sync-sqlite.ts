import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { preset } from "@tinker/core/testing";

import { database } from "~/components/database-sqlite/index.server";
import type { Database } from "~/components/database-sqlite/index.server";
import { accountNotice } from "~/components/sync-sqlite/notice";

const migrations = fileURLToPath(new URL("../../../sqlite/migrations", import.meta.url));

/** The SQLite `database` handle with only `listen` supplied; both connections are in memory. */
export function listenOnly(listen: Database.Handle["listen"]) {
  return preset(database, async (_deps, { defer }): Promise<Database.Handle> => {
    const memory = new DatabaseSync(":memory:");

    defer(() => memory.close());

    return { client: memory, reader: memory, writeTurn: async () => () => {}, wake() {}, listen };
  });
}

/**
 * A migrated temp SQLite file as the app's database, with `listen` woken by hand. `logRead` sees
 * every statement prepared on the read connection, as the Postgres twin's query log does.
 */
export function handWoken(logRead?: (query: string) => void) {
  const wakes: ((payload: string) => void)[] = [];

  const db = preset(database, async (_deps, { defer }): Promise<Database.Handle> => {
    const home = await mkdtemp(join(tmpdir(), "tinker-sync-sqlite-fixture-"));
    const file = join(home, "app.db");
    const client = new DatabaseSync(file);

    for (const name of (await readdir(migrations)).sort()) {
      client.exec(await readFile(join(migrations, name), "utf8"));
    }

    const reader = new DatabaseSync(file);

    defer(async () => {
      client.close();
      reader.close();

      await rm(home, { recursive: true, force: true });
    });

    const logged = new Proxy(reader, {
      get(target, key) {
        const value = Reflect.get(target, key, target);

        if (key === "prepare" && logRead) {
          return (query: string) => {
            logRead(query);

            return target.prepare(query);
          };
        }

        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    return {
      client,
      reader: logged,
      writeTurn: async () => () => {},
      wake() {},
      listen: async (_channel: string, wake: (payload: string) => void) => {
        wakes.push(wake);

        return () => {};
      },
    };
  });

  return {
    db,
    emit: (payload: string) => wakes.forEach((wake) => wake(payload)),
    wake: () => wakes.forEach((wake) => wake("sync_event")),
    /** The notice an auth path sends on the sync channel, for one account. */
    notice: (accountId: string) => wakes.forEach((wake) => wake(accountNotice(accountId))),
  };
}
