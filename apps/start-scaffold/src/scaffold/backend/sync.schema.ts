import { pgTable, text, integer, jsonb, primaryKey } from "drizzle-orm/pg-core";
import type { Sync } from "../sync.ts";
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
