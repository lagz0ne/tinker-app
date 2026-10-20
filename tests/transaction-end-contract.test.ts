import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { expect, test } from "vite-plus/test";

import {
  database,
  databaseLockTimeout,
  databaseStatementTimeout,
  leaseFrom,
  migrate,
  transaction,
  type Database,
} from "~/components/database/index.server";

for (const queried of [false, true]) {
  for (const end of ["commit", "rollback"] as const) {
    test(`explicit ${end} is final and idempotent, queried=${queried}`, async () => {
      const queries: string[] = [];
      const releases: (boolean | undefined)[] = [];
      let acquired = 0;
      let guard: Database.QueryGuard | undefined;
      const client = {
        query: async (config: string | { text: string }) => {
          queries.push(typeof config === "string" ? config : config.text);
          return { rows: [], rowCount: 0 };
        },
        release: (broken?: boolean) => releases.push(broken),
      } as unknown as PoolClient;
      const root = createScope({
        tags: [databaseLockTimeout(123), databaseStatementTimeout(456)],
        presets: [
          preset(database, async () =>
            Object.assign(drizzle({ client }), {
              listen: async () => () => {},
              checkout: async (input?: Database.QueryGuard) => {
                guard = input;
                return leaseFrom(
                  async () => {
                    acquired++;
                    return client;
                  },
                  drizzle,
                  input,
                );
              },
            }),
          ),
        ],
      });
      const session = root.createSession();

      try {
        const tx = await session.resolve(transaction);

        expect(acquired).toBe(0);
        expect(() => tx.transaction(async () => {})).toThrow(
          expect.objectContaining({ kind: "NestedTransaction", payload: {} }),
        );
        if (queried) await tx.execute(sql`SELECT 7`);
        await tx[end]();
        const ended = [...queries];
        await tx.commit();
        await tx.rollback();
        await expect(tx.execute(sql`SELECT 8`)).rejects.toMatchObject({
          kind: "TransactionEnded",
          payload: {},
        });
        expect(() => guard!.check()).toThrow(
          expect.objectContaining({ kind: "TransactionEnded", payload: {} }),
        );
        await expect(guard!.begin()).rejects.toMatchObject({
          kind: "TransactionEnded",
          payload: {},
        });
        expect((await session.close({ graceful: true })).status).toBe("success");
        expect(queries).toEqual(ended);
        expect(queries).toEqual(
          queried
            ? [
                "BEGIN",
                "SET LOCAL lock_timeout = '123ms'",
                "SET LOCAL statement_timeout = '456ms'",
                "SELECT 7",
                end === "commit" ? "COMMIT" : "ROLLBACK",
              ]
            : [],
        );
        expect(acquired).toBe(queried ? 1 : 0);
        expect(releases).toEqual(queried ? [false] : []);
      } finally {
        await session.close();
        await root.close();
      }
    });
  }
}

test("missing write and migration checkout fail with a useful adapter error", async () => {
  const root = createScope({ presets: [preset(database, async () => ({}) as Database.Handle)] });
  const session = root.createSession();
  try {
    await expect(session.resolve(transaction)).rejects.toThrow(
      "Database preset must supply checkout for writes",
    );
    const result = await root.settle(migrate);
    expect(result).toMatchObject({
      status: "failed",
      error: { message: "Migration requires a dedicated connection" },
    });
  } finally {
    await session.close();
    await root.close();
  }
});

for (const end of ["commit", "rollback"] as const) {
  test(`session close joins an explicit in-flight ${end}`, async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<{ rows: unknown[] }>();
    const queries: string[] = [];
    const releases: unknown[] = [];
    const client = {
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;
        queries.push(text);
        if (text === end.toUpperCase()) {
          entered.resolve();
          return finish.promise;
        }
        return { rows: [] };
      },
      release: (broken?: boolean) => releases.push(broken),
    } as unknown as PoolClient;
    const root = createScope({
      presets: [
        preset(database, async () =>
          Object.assign(drizzle({ client }), {
            listen: async () => () => {},
            checkout: async (guard?: Database.QueryGuard) =>
              leaseFrom(async () => client, drizzle, guard),
          }),
        ),
      ],
    });
    const session = root.createSession();

    try {
      const tx = await session.resolve(transaction);
      await tx.execute(sql`SELECT 1`);
      const ending = tx[end]();
      await entered.promise;
      let closed = false;
      const closing = session.close({ graceful: true }).then((value) => {
        closed = true;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(closed).toBe(false);
      expect(releases).toEqual([]);
      finish.resolve({ rows: [] });
      await ending;
      expect((await closing).status).toBe("success");
      expect(releases).toEqual([false]);
      expect(queries.filter((query) => ["COMMIT", "ROLLBACK"].includes(query))).toEqual([
        end.toUpperCase(),
      ]);
    } finally {
      finish.resolve({ rows: [] });
      await session.close();
      await root.close();
    }
  });
}

for (const end of ["commit", "rollback"] as const) {
  test(`failed explicit ${end} fences the handle and destroys its client once`, async () => {
    const error = new Error("refused " + end);
    const queries: string[] = [];
    const releases: unknown[] = [];
    const client = {
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;
        queries.push(text);
        if (text === end.toUpperCase()) throw error;
        return { rows: [] };
      },
      release: (broken?: boolean) => {
        releases.push(broken);
      },
    } as unknown as PoolClient;
    const root = createScope({
      presets: [
        preset(database, async () =>
          Object.assign(drizzle({ client }), {
            listen: async () => () => {},
            checkout: async (guard?: Database.QueryGuard) =>
              leaseFrom(async () => client, drizzle, guard),
          }),
        ),
      ],
    });
    const session = root.createSession();

    try {
      const tx = await session.resolve(transaction);
      await tx.execute(sql`SELECT 1`);
      await expect(tx[end]()).rejects.toBe(error);
      await expect(tx.execute(sql`SELECT 2`)).rejects.toMatchObject({ kind: "TransactionEnded" });
      const ended = [...queries];
      await tx.commit();
      await tx.rollback();
      await session.close({ graceful: true });

      expect(queries).toEqual(ended);
      expect(queries.filter((query) => query === "ROLLBACK")).toHaveLength(1);
      expect(releases).toEqual([true]);
    } finally {
      await session.close();
      await root.close();
    }
  });
}
