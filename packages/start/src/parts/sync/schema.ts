import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { Sync } from "./envelopes";
/**
 * The sync part's three tables. The app's migrations create them, and a `start_sync` trigger on
 * `sync_event` inserts (see the README).
 */
export const stream = pgTable("sync_stream", {
  id: text().primaryKey(),
  revision: integer().notNull().default(0),
});
export const execution = pgTable("sync_execution", {
  id: text().primaryKey(),
  stream: text().notNull(),
  notification: jsonb().$type<unknown>(),
  result: jsonb().$type<unknown>(),
});
export const event = pgTable(
  "sync_event",
  {
    stream: text().notNull(),
    revision: integer().notNull(),
    executionId: text().notNull(),
    payload: jsonb().$type<Sync.Envelope["payload"]>().notNull(),
  },
  (row) => [primaryKey({ columns: [row.stream, row.revision] })],
);
