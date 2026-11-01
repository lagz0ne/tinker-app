import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The same tables, SQLite dialect. Every SQLite driver serves this schema. */
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  votes: integer("votes").notNull().default(0),
});
