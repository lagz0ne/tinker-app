import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
export declare namespace Database {
  type Handle = PgAsyncDatabase<PgQueryResultHKT> & {
    listen: (wake: () => void, disconnected: () => void) => Promise<() => Promise<void>>;
  };
  type Transaction = Parameters<Parameters<Handle["transaction"]>[0]>[0];
}
