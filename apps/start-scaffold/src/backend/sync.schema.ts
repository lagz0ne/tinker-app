import { pgTable, text, integer, jsonb, primaryKey } from "drizzle-orm/pg-core";
import type { Sync } from "../contracts/sync.ts";
import type { Mail } from "./mail.ts";
export const stream = pgTable("sync_stream", {
  id: text().primaryKey(),
  revision: integer().notNull().default(0),
});
export const execution = pgTable("sync_execution", {
  id: text().primaryKey(),
  stream: text().notNull(),
  notification: jsonb().$type<Mail.Message>(),
  result: jsonb().$type<Sync.Result>(),
});
export const event = pgTable(
  "sync_event",
  {
    stream: text().notNull(),
    revision: integer().notNull(),
    executionId: text().notNull(),
    payload: jsonb().$type<Sync.Payload>().notNull(),
  },
  (row) => [primaryKey({ columns: [row.stream, row.revision] })],
);
export const counter = pgTable("public_counter", {
  id: integer().primaryKey(),
  value: integer().notNull().default(0),
});
