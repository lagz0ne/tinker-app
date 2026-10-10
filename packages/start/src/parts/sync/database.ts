import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export declare namespace Database {
  /**
   * What the server seam's `database` gives the sync part: a drizzle Postgres database, and
   * `listen`, which calls `heard` with the payload of each `start_sync` notification until the
   * returned stop. A payload is a table name for a saved change, or `account:<id>` for a notice.
   */
  type Handle = PgAsyncDatabase<PgQueryResultHKT> & {
    listen: (
      heard: (payload: string) => void,
      disconnected: () => void,
    ) => Promise<() => void | Promise<void>>;
  };
  type Transaction = Parameters<Parameters<Handle["transaction"]>[0]>[0];
}
