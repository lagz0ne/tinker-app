import { createScope, operation } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { expect, test } from "vite-plus/test";

import { database, drizzleOrm, leaseFrom, transaction } from "~/components/database/index.server";

for (const failed of ["BEGIN", "COMMIT", "ROLLBACK", "COMMIT+ROLLBACK"]) {
  test(`failed ${failed} destroys the checked-out client`, async () => {
    const queries: string[] = [];

    const releases: (boolean | undefined)[] = [];

    const release = (broken?: boolean) => {
      releases.push(broken);
    };

    const connection = {
      release,
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;

        queries.push(text);

        if (failed.split("+").includes(text)) throw new Error("injected " + text);

        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;

    const handle = Object.assign(drizzle({ client: connection }), {
      listen: async () => () => {},
      checkout: async (guard?: import("~/components/database/index.server").Database.QueryGuard) =>
        leaseFrom(async () => connection, drizzle, guard),
    });

    const root = createScope({ presets: [preset(database, async () => handle)] });

    const step = operation({
      label: "proof.failedEnd",
      depends: { tx: transaction, orm: drizzleOrm },
      run: async ({ tx, orm }, { raise }) => {
        await tx.execute(orm.sql`SELECT 1`);

        if (failed === "ROLLBACK") raise("StepRefused", {});

        return "saved";
      },
    });

    const result = await root.settle(step, { signal: new AbortController().signal });

    expect(result.status).toBe("failed");

    expect(queries[0]).toBe("BEGIN");

    expect(releases).toEqual([true]);

    await root.close({ graceful: true });
  });
}

for (const queried of [false, true]) {
  test(`transaction resolves with no checkout; queried=${queried}`, async () => {
    let acquired = 0;

    const releases: (boolean | undefined)[] = [];

    const queries: string[] = [];

    const connection = {
      release: (broken?: boolean) => releases.push(broken),
      query: async (config: string | { text: string }) => {
        queries.push(typeof config === "string" ? config : config.text);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;

    const handle = Object.assign(drizzle({ client: connection }), {
      listen: async () => () => {},
      checkout: async (guard?: import("~/components/database/index.server").Database.QueryGuard) =>
        leaseFrom(
          async () => {
            acquired += 1;
            return connection;
          },
          drizzle,
          guard,
        ),
    });

    const root = createScope({ presets: [preset(database, async () => handle)] });

    const step = operation({
      label: "proof.lazyCheckout",
      depends: { tx: transaction, orm: drizzleOrm },
      run: async ({ tx, orm }) => {
        expect(acquired).toBe(0);

        expect(releases).toEqual([]);

        if (queried) {
          await Promise.all([tx.execute(orm.sql`SELECT 1`), tx.execute(orm.sql`SELECT 2`)]);
        }
      },
    });

    expect((await root.settle(step, { signal: new AbortController().signal })).status).toBe(
      "success",
    );

    expect(acquired).toBe(queried ? 1 : 0);

    expect(releases).toEqual(queried ? [false] : []);

    expect(queries).toEqual(queried ? ["BEGIN", "SELECT 1", "SELECT 2", "COMMIT"] : []);

    await root.close({ graceful: true });
  });
}
