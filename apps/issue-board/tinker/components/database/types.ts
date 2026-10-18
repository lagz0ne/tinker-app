import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export declare namespace Database {
  /**
   * What the server seam's `database` gives the sync part: a drizzle Postgres database, and
   * `listen(channel, heard, disconnected, signal?)`, which calls `heard` until the
   * returned stop. A payload is a table name for a saved change, or `account:<id>` for a notice.
   */
  type QueryGuard = {
    check(): void;

    begin(): Promise<void>;

    logQuery?(query: string, params: unknown[]): void;
  };

  type Lease = {
    db: PgAsyncDatabase<PgQueryResultHKT>;
    query: (text: string) => Promise<unknown>;

    release: (broken?: boolean) => void;
  };
  type Handle = PgAsyncDatabase<PgQueryResultHKT> & {
    checkout?: (guard?: QueryGuard) => Promise<Lease>;
    listen: (
      channel: string,
      heard: (payload: string) => void,
      disconnected: () => void,
      signal?: AbortSignal,
    ) => Promise<() => void | Promise<void>>;
  };
  type Transaction = PgAsyncDatabase<PgQueryResultHKT>;
  type SessionTransaction = Transaction & {
    commit(): Promise<void>;
    rollback(): Promise<void>;
  };
}
