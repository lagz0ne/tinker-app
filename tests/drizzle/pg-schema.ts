import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";

/** The app's own tables, Postgres dialect. Every pg driver serves the same schema. */
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  votes: integer("votes").notNull().default(0),
});
