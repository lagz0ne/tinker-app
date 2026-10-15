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
          (payload) => heard.push(payload),
          () => {
            failures++;
          },
        ),
      ).rejects.toBe(error);
    } else {
      const close = await db.listen(
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
        (payload) => heard.push(payload),
        () => {
          failures++;
        },
      );
    }
    expect(options).toEqual([{ connectionString: "postgres://u:p@db.test/app" }]);
    expect(queries).toEqual(
      refuse ? ["LISTEN start_sync"] : ["LISTEN start_sync", "LISTEN start_sync"],
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
  expect(rows).toMatchObject({ rows: [{ count: 7 }] });
  expect((await root.close({ graceful: true })).status).toBe("success");
});
