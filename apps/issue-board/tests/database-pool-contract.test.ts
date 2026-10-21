import { EventEmitter, getEventListeners } from "node:events";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import { expect, test } from "vite-plus/test";

import { database, databaseStop, databaseUrl } from "~/components/database/index.server";
import { postgres } from "~/components/database/modules";

for (const failed of [false, true]) {
  test(`worker pool read ${failed ? "failure" : "success"} releases once and drops its abort listener`, async () => {
    const stop = new AbortController();
    const error = new Error("query failed");
    const queries: unknown[][] = [];
    const releases: unknown[] = [];
    let connections = 0;
    let ended = false;
    const client = {
      query: async (...args: unknown[]) => {
        expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
        queries.push(args);
        if (failed) throw error;
        return { rows: [{ value: 42 }] };
      },
      release: (broken?: boolean) => {
        releases.push(broken);
      },
    };
    const root = createScope({
      tags: [databaseUrl(new URL("postgres://proof")), databaseStop(stop.signal)],
      presets: [
        preset(
          postgres,
          async () =>
            ({
              default: {
                Pool: function Pool() {
                  return {
                    on: () => {},
                    connect: async () => {
                      connections++;
                      return client;
                    },
                    query: async () => {
                      throw new Error("stoppable reads must borrow one connection");
                    },
                    end: async () => {
                      ended = true;
                    },
                  };
                },
              },
            }) as unknown as typeof import("pg"),
        ),
      ],
    });

    try {
      const db = await root.resolve(database);
      if (failed) await expect(db.execute(sql`SELECT 42`)).rejects.toMatchObject({ cause: error });
      else expect(await db.execute(sql`SELECT 42`)).toEqual({ rows: [{ value: 42 }] });

      expect(connections).toBe(1);
      expect(queries).toHaveLength(1);
      expect(releases).toEqual([undefined]);
      expect(getEventListeners(stop.signal, "abort")).toEqual([]);
      stop.abort();
      expect(releases).toEqual([undefined]);
      await root.close({ graceful: true });
      expect(ended).toBe(true);
    } finally {
      await root.close();
    }
  });
}

test("caller abort interrupts an established LISTEN and removes every listener", async () => {
  const stop = new AbortController();
  const reason = new Error("close listener");
  const released: unknown[] = [];
  const heard: unknown[] = [];
  let disconnected = 0;
  const client = Object.assign(new EventEmitter(), {
    query: async (text: string) => {
      expect(text).toBe("LISTEN board_outbox");
    },
    release: (broken?: boolean) => {
      released.push(broken);
    },
  });
  const root = createScope({
    tags: [databaseUrl(new URL("postgres://proof"))],
    presets: [
      preset(
        postgres,
        async () =>
          ({
            default: {
              Pool: function Pool() {
                return { on: () => {}, connect: async () => client, end: async () => {} };
              },
            },
          }) as unknown as typeof import("pg"),
      ),
    ],
  });

  try {
    const db = await root.resolve(database);
    const close = await db.listen(
      "board_outbox",
      (payload) => heard.push(payload),
      () => {
        disconnected++;
      },
      stop.signal,
    );
    client.emit("notification", { payload: "wake" });
    client.emit("end");

    expect(heard).toEqual(["wake"]);
    expect(disconnected).toBe(1);
    stop.abort(reason);
    expect(released).toEqual([true]);
    expect(client.eventNames()).toEqual([]);
    expect(getEventListeners(stop.signal, "abort")).toEqual([]);
    await close();
    await root.close({ graceful: true });
    expect(released).toEqual([true]);
  } finally {
    await root.close();
  }
});

test("named listeners accept one-character and full-length Postgres identifiers", async () => {
  const queries: string[] = [];
  const releases: unknown[] = [];
  const names = ["a", "_", "a".repeat(63)];
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
                  on: () => {},
                  connect: async () =>
                    Object.assign(new EventEmitter(), {
                      query: async (text: string) => {
                        queries.push(text);
                      },
                      release: (broken?: boolean) => {
                        releases.push(broken);
                      },
                    }),
                  end: async () => {},
                };
              },
            },
          }) as unknown as typeof import("pg"),
      ),
    ],
  });

  try {
    const db = await root.resolve(database);
    for (const name of names) {
      const close = await db.listen(
        name,
        () => {},
        () => {},
      );
      await close();
    }

    expect(queries).toEqual(names.map((name) => "LISTEN " + name));
    expect(releases).toEqual([true, true, true]);
    await root.close({ graceful: true });
    expect(releases).toHaveLength(3);
  } finally {
    await root.close();
  }
});
