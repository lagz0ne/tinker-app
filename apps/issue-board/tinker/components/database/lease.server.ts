import type { Database } from "./types";

/**
 * Native driver bridge shared by production and test adapters. A declaration cannot
 * own a checked-out client; the database resource owns checkout and session release.
 * @param connect - From the resource; why: acquire one client only when BEGIN queries it.
 * @param drizzle - From the lazy driver module; why: bind its database to that client.
 * @param guard - From transaction; why: reject ended queries and await lazy BEGIN.
 */
export function leaseFrom<
  C extends { query: (...args: never[]) => unknown; release(broken?: boolean): void },
>(
  connect: () => Promise<C>,
  drizzle: (options: {
    client: C;

    logger: { logQuery(query: string, params: unknown[]): void };
  }) => Database.Transaction,
  guard?: Database.QueryGuard,
): Database.Lease {
  let pending: Promise<C> | undefined;
  let connection: C | undefined;

  async function query(...args: unknown[]) {
    await guard?.begin();
    const client = await (pending ??= connect().then((client) => {
      connection = client;
      return client;
    }));
    return Reflect.apply(client.query, client, args);
  }

  return {
    db: drizzle({
      client: new Proxy({} as C, {
        get(_target, key) {
          if (key === "query") return query;
          return connection && Reflect.get(connection, key, connection);
        },
      }),
      // Reject before Drizzle wraps a driver error.
      logger: {
        logQuery(query, params) {
          guard?.check();

          guard?.logQuery?.(query, params);
        },
      },
    }),
    async query(text) {
      const client = await (pending ??= connect().then((client) => {
        connection = client;
        return client;
      }));
      return Reflect.apply(client.query, client, [text]);
    },
    release: (broken) => connection?.release(broken),
  };
}
