import type { DatabaseSync } from "node:sqlite";

export declare namespace Database {
  /**
   * What the server seam's `database` gives the rest of the app: the write and the read
   * connection, the one write turn this process allows, and
   * `listen(channel, heard, disconnected, signal?)`, which calls `heard` until the returned stop.
   */
  type Handle = {
    /** The write connection. Only a `transaction` session writes through it. */
    client: DatabaseSync;
    /** The read connection. WAL lets page reads run beside the writer. */
    reader: DatabaseSync;
    /** Wait for the process's one write transaction, then return the function that releases it. */
    writeTurn(signal?: AbortSignal): Promise<() => void>;
    /** Wake every listener now, after this process committed a notify row. */
    wake(): void;
    listen: (
      channel: string,
      heard: (payload: string) => void,
      disconnected: () => void,
      signal?: AbortSignal,
    ) => Promise<() => void>;
  };

  /** A call's session transaction: lazy `BEGIN IMMEDIATE`, one end, then the write turn. */
  type SessionTransaction = {
    db(): Promise<DatabaseSync>;
    notify(channel: string, payload: string): Promise<void>;
    /** A session owns one transaction: a nested call throws `NestedTransaction`. */
    transaction(): never;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  };
}
