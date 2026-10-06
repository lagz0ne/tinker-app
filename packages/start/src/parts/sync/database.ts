import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export declare namespace Database {
  /**
   * What the server seam's `database` gives the sync part: a drizzle Postgres database, and
   * `listen`, which calls `wake` on each `start_sync` notification until the returned stop.
   */
  type Handle = PgAsyncDatabase<PgQueryResultHKT> & {
    listen: (wake: () => void, disconnected: () => void) => Promise<() => void | Promise<void>>;
  };
  type Transaction = Parameters<Parameters<Handle["transaction"]>[0]>[0];
}
