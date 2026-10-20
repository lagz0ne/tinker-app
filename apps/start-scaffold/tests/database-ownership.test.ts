import { EventEmitter, getEventListeners } from "node:events";

import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import { expect, test } from "vite-plus/test";

import {
  database,
  databaseUrl,
  databaseStop,
  databaseSetup,
  databaseMigrationTimeout,
  migrate,
} from "~/components/database/index.server";
import { postgres, drizzlePgCore, drizzleMigrator } from "~/components/database/modules";

function migrationHarness(
  options: {
    grantAfter?: number;
    failAt?: string;
    cancelAt?: "owned" | "migration";
    startup?: boolean;
  } = {},
) {
  const clock = makeTestClock({ now: 1000 });

  const stop = new AbortController();

  const error = new Error("native migration failed");

  const reason = new Error("worker stopped");

  const queries: string[] = [];

  const sleeps: number[] = [];

  const released: boolean[] = [];

  const pending = Promise.withResolvers<{ rows: unknown[] }>();

  const entered = Promise.withResolvers<void>();

  const sleeping = Promise.withResolvers<void>();

  const files: unknown[] = [];

  const grantAfter = options.grantAfter ?? 3;

  let owned = false;

  let attempts = 0;

  let checkouts = 0;

  const client = {
    async query(config: string | { text: string }) {
      const text = typeof config === "string" ? config : config.text;

      queries.push(text);

      if (options.failAt && text.includes(options.failAt)) throw error;

      if (text.includes("pg_try_advisory_lock")) {
        owned = ++attempts >= grantAfter;

        if (options.cancelAt === "owned") stop.abort(reason);

        return { rows: [{ owned }] };
      }

      if (text === "SELECT migration_step") {
        expect(owned, "DDL must run on the connection that owns the lock").toBe(true);

        entered.resolve();

        if (options.cancelAt === "migration") return pending.promise;
      }

      return { rows: [] };
    },
    release(broken: boolean) {
      released.push(broken);

      if (options.cancelAt === "migration" && broken) pending.reject(reason);
    },
  };

  const root = createScope({
    clock: {
      ...clock,
      async sleep(ms, signal) {
        sleeps.push(ms);

        if (options.startup) {
          sleeping.resolve();

          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }

        signal?.throwIfAborted();

        clock.advance(ms);
      },
    },
    extensions: options.startup ? [databaseSetup] : [],
    tags: [
      databaseUrl(new URL("postgres://proof")),
      databaseMigrationTimeout(120),
      options.startup && databaseStop(stop.signal),
    ],
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
                    checkouts++;

                    return client;
                  },
                  query: async () => {
                    throw new Error("migrations cannot use the unleased pool");
                  },
                  end: async () => {},
                };
              },
            },
          }) as unknown as typeof import("pg"),
      ),
      preset(
        drizzleMigrator,
        async () =>
          ({
            readMigrationFiles: (config: unknown) => {
              expect(config).toEqual({ migrationsFolder: "drizzle" });

              return files;
            },
          }) as unknown as typeof import("drizzle-orm/migrator"),
      ),
      preset(
        drizzlePgCore,
        async () =>
          ({
            migrate: async (
              input: unknown,
              db: { execute: (query: unknown) => Promise<unknown> },
              config: unknown,
            ) => {
              expect(input).toBe(files);

              expect(config).toEqual({ migrationsFolder: "drizzle" });

              await db.execute(sql`SELECT migration_step`);
            },
          }) as unknown as typeof import("drizzle-orm/pg-core"),
      ),
    ],
  });

  return {
    root,
    stop,
    error,
    reason,
    queries,
    sleeps,
    released,
    pending,
    entered,
    sleeping,
    checkouts: () => checkouts,
  };
}

for (const available of [true, false]) {
  test(`migration ${available ? "waits for ownership then unlocks its one lease" : "ends a bounded ownership wait with MigrationBusy"}`, async () => {
    const state = migrationHarness({ grantAfter: available ? 3 : Infinity });

    try {
      await state.root.ready;

      const result = await state.root.settle(migrate);

      expect(state.queries[0], "migration must attempt the ownership lock first").toContain(
        "pg_try_advisory_lock",
      );

      if (available) {
        expect(result.status).toBe("success");

        expect(state.sleeps).toEqual([50, 50]);

        expect(
          state.queries.filter((query) => query.includes("pg_try_advisory_lock")),
        ).toHaveLength(3);

        expect(state.queries.at(-1)).toContain("pg_advisory_unlock($1, $2)");

        expect(state.released).toEqual([false]);
      } else {
        expect(result).toMatchObject({
          status: "failed",
          error: { kind: "MigrationBusy", payload: { timeout: 120 } },
        });

        expect(state.sleeps).toEqual([50, 50, 20]);

        expect(state.queries.every((query) => query.includes("pg_try_advisory_lock"))).toBe(true);

        expect(state.released).toEqual([true]);
      }

      expect(state.checkouts()).toBe(1);
    } finally {
      await state.root.close();
    }
  });
}

for (const phase of ["pg_try_advisory_lock", "SELECT migration_step", "pg_advisory_unlock"]) {
  test(`migration destroys its leased client after ${phase} fails`, async () => {
    const state = migrationHarness({ grantAfter: 1, failAt: phase });

    try {
      await state.root.ready;

      const result = await state.root.settle(migrate);

      expect(result).toMatchObject({ status: "failed", error: { cause: state.error } });

      expect(state.released, "a failed migration must destroy its connection").toEqual([true]);

      expect(state.checkouts()).toBe(1);
    } finally {
      await state.root.close();
    }
  });
}

test("migration stops before DDL when stop arrives with the ownership result", async () => {
  const state = migrationHarness({ grantAfter: 1, cancelAt: "owned" });

  try {
    await state.root.ready;

    const result = await state.root.settle(migrate, { signal: state.stop.signal });

    expect(result.status).not.toBe("success");

    expect(state.queries.some((query) => query === "SELECT migration_step")).toBe(false);

    expect(state.released).toEqual([true]);
  } finally {
    await state.root.close();
  }
});

test("migration abort destroys the active lease exactly once", async () => {
  const state = migrationHarness({ grantAfter: 1, cancelAt: "migration" });

  await state.root.ready;

  const running = state.root.settle(migrate, { signal: state.stop.signal });

  try {
    await state.entered.promise;

    state.stop.abort(state.reason);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(state.released).toEqual([true]);

    expect((await running).status).not.toBe("success");

    expect(state.queries.some((query) => query.includes("pg_advisory_unlock"))).toBe(false);

    expect(state.released).toEqual([true]);
  } finally {
    state.pending.reject(state.reason);

    await running;

    await state.root.close();
  }
});

test("database setup passes worker stop to an ownership wait before ready", async () => {
  const state = migrationHarness({ grantAfter: Infinity, startup: true });

  let rejected: unknown;

  const ready = state.root.ready.catch((error) => {
    rejected = error;
  });

  try {
    await state.sleeping.promise;

    expect(rejected).toBeUndefined();

    state.stop.abort(state.reason);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(rejected, "startup must follow the worker stop").toBe(state.reason);

    expect(state.released).toEqual([true]);
  } finally {
    await state.root.close();

    await ready;
  }
});

for (const phase of ["query", "connect"]) {
  test(`worker pool stop cancels ${phase} and refuses another read without checkout`, async () => {
    const stop = new AbortController();

    const reason = new Error("stop worker read");

    const entered = Promise.withResolvers<void>();

    const connecting = Promise.withResolvers<unknown>();

    const response = Promise.withResolvers<{ rows: unknown[] }>();

    const released: boolean[] = [];

    let checkouts = 0;

    let queries = 0;

    let outcome: unknown;

    const client = {
      query: async () => {
        queries++;

        entered.resolve();

        return response.promise;
      },
      release: (broken: boolean) => {
        released.push(broken);

        if (queries) response.reject(reason);
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
                      checkouts++;

                      if (phase === "connect") {
                        entered.resolve();

                        return connecting.promise;
                      }

                      return client;
                    },
                    query: async () => {
                      entered.resolve();

                      return response.promise;
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

    const db = await root.resolve(database);

    const work = db.execute(sql`SELECT 1`).then(
      (value) => {
        outcome = value;
      },
      (error) => {
        outcome = error;
      },
    );

    try {
      await entered.promise;

      stop.abort(reason);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome, "pool read must stop without waiting for its native query").toMatchObject({
        cause: reason,
      });

      connecting.resolve(client);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(released).toEqual([true]);

      expect(queries).toBe(phase === "query" ? 1 : 0);

      await expect(db.execute(sql`SELECT 2`)).rejects.toMatchObject({ cause: reason });

      expect(checkouts).toBe(1);
    } finally {
      connecting.resolve(client);

      response.resolve({ rows: [] });

      await work;

      await root.close();
    }
  });
}

for (const refused of [false, true]) {
  test(`listener ${refused ? "failure" : "explicit stop"} removes its caller's abort listener`, async () => {
    const stop = new AbortController();

    const error = new Error("LISTEN failed");

    const released: boolean[] = [];

    const client = Object.assign(new EventEmitter(), {
      query: async () => {
        if (refused) throw error;
      },
      release: (broken: boolean) => released.push(broken),
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
      await root.ready;

      const db = await root.resolve(database);

      const opening = db.listen(
        "board_outbox",
        () => {},
        () => {},
        stop.signal,
      );

      if (refused) await expect(opening).rejects.toBe(error);
      else {
        const close = await opening;

        expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);

        await close();
      }

      expect(
        getEventListeners(stop.signal, "abort"),
        "listener close must unsubscribe from caller stop",
      ).toHaveLength(0);

      expect(client.eventNames()).toEqual([]);

      expect(released).toEqual([true]);
    } finally {
      await root.close();
    }
  });
}
