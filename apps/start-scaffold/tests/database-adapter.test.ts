import { EventEmitter } from "node:events";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import { expect, test } from "vite-plus/test";

import { database, databaseUrl, databaseSetup } from "~/components/database/database.server";
import { postgres } from "~/components/database/modules";

import { proofDatabase } from "./presets";

for (const refuse of [false, true]) {
  test(`Postgres listener ${refuse ? "cleans up a refused LISTEN" : "routes events and releases all listeners before ending its pool"}`, async () => {
    const connected: EventEmitter[] = [];
    const released: boolean[] = [];
    const queries: string[] = [];
    const options: unknown[] = [];
    const order: string[] = [];
    const error = new Error("LISTEN refused");
    class Pool {
      constructor(config: unknown) {
        options.push(config);
      }
      async query(config: { text: string }) {
        expect(config.text).toBe("select 42 as value");
        return { rows: [{ value: 42 }] };
      }
      async connect() {
        const listener = Object.assign(new EventEmitter(), {
          query: async (text: string) => {
            queries.push(text);
            if (refuse) throw error;
          },
          release: (destroy: boolean) => {
            released.push(destroy);
            order.push("release");
          },
        });
        connected.push(listener);
        return listener;
      }
      async end() {
        order.push("end");
      }
    }
    const root = createScope({
      tags: [databaseUrl(new URL("postgres://u:p@db.test/app"))],
      presets: [
        preset(postgres, async () => ({ default: { Pool } }) as unknown as typeof import("pg")),
      ],
    });

    await root.ready;
    const db = await root.resolve(database);
    expect(await db.execute(sql`select 42 as value`)).toMatchObject({ rows: [{ value: 42 }] });
    const heard: string[] = [];
    let failures = 0;
    if (refuse) {
      await expect(
        db.listen(
          "start_sync",
          (payload) => heard.push(payload),
          () => {
            failures++;
          },
        ),
      ).rejects.toBe(error);
    } else {
      const close = await db.listen(
        "start_sync",
        (payload) => heard.push(payload),
        () => {
          failures++;
        },
      );
      const listener = connected[0]!;
      listener.emit("notification", { payload: "account:abc" });
      listener.emit("notification", {});

      listener.emit("error", new Error("connection failed"));
      listener.emit("end");
      expect(heard).toEqual(["account:abc", ""]);
      expect(failures).toBe(2);

      await close();

      await close();
      expect(listener.eventNames()).toEqual([]);
      listener.emit("notification", { payload: "late" });
      listener.emit("end");
      expect(heard).toEqual(["account:abc", ""]);
      expect(failures).toBe(2);
      await db.listen(
        "board_outbox",
        (payload) => heard.push(payload),
        () => {
          failures++;
        },
      );
    }
    expect(options).toEqual([
      { connectionString: "postgres://u:p@db.test/app", connectionTimeoutMillis: 5000 },
    ]);
    expect(queries).toEqual(
      refuse ? ["LISTEN start_sync"] : ["LISTEN start_sync", "LISTEN board_outbox"],
    );
    expect((await root.close({ graceful: true })).status).toBe("success");
    expect(released).toEqual(refuse ? [true] : [true, true]);
    expect(order).toEqual(refuse ? ["release", "end"] : ["release", "release", "end"]);
    for (const listener of connected) expect(listener.eventNames()).toEqual([]);
  });
}

test("database setup runs the real migrations before ready resolves", async () => {
  const root = createScope({
    extensions: [databaseSetup],
    tags: [databaseUrl(new URL("postgres://proof"))],
    presets: [proofDatabase],
  });

  await root.ready;
  const db = await root.resolve(database);
  const rows = await db.execute(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  expect(rows).toMatchObject({ rows: [{ count: 8 }] });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("listener rejects unsafe channel names and an already-aborted call before checkout", async () => {
  let checkouts = 0;

  const root = createScope({
    tags: [databaseUrl(new URL("postgres://proof"))],
    presets: [
      preset(
        postgres,
        async () =>
          ({
            default: {
              Pool: function Pool() {
                return {
                  connect: async () => {
                    checkouts++;
                    throw new Error("no checkout");
                  },
                  end: async () => {},
                };
              },
            },
          }) as unknown as typeof import("pg"),
      ),
    ],
  });

  await root.ready;

  try {
    const db = await root.resolve(database);

    for (const channel of ["", "a;DROP TABLE x", "A", "1a", "a".repeat(64)]) {
      await expect(
        db.listen(
          channel,
          () => {},
          () => {},
        ),
      ).rejects.toThrow();
    }
    const stop = new AbortController();

    const reason = new Error("stop before checkout");

    stop.abort(reason);

    await expect(
      db.listen(
        "board_outbox",
        () => {},
        () => {},
        stop.signal,
      ),
    ).rejects.toBe(reason);

    expect(checkouts).toBe(0);
  } finally {
    await root.close();
  }
});

test("cancelled listener releases a late checkout once without running LISTEN", async () => {
  const connecting = Promise.withResolvers<unknown>();

  const released: boolean[] = [];

  let queries = 0;

  const connection = Object.assign(new EventEmitter(), {
    query: async () => {
      queries++;
    },
    release: (broken: boolean) => released.push(broken),
  });

  const stop = new AbortController();

  const root = createScope({
    tags: [databaseUrl(new URL("postgres://proof"))],
    presets: [
      preset(
        postgres,
        async () =>
          ({
            default: {
              Pool: function Pool() {
                return { connect: () => connecting.promise, end: async () => {} };
              },
            },
          }) as unknown as typeof import("pg"),
      ),
    ],
  });

  await root.ready;

  try {
    const db = await root.resolve(database);

    const listening = db.listen(
      "board_outbox",
      () => {},
      () => {},
      stop.signal,
    );

    stop.abort();

    await expect(listening).rejects.toBe(stop.signal.reason);

    connecting.resolve(connection);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(released).toEqual([true]);

    expect(queries).toBe(0);

    expect(connection.eventNames()).toEqual([]);
  } finally {
    connecting.resolve(connection);
    await root.close();
  }
});
