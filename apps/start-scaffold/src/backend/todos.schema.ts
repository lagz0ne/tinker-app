import { pgTable, integer, text, boolean, index } from "drizzle-orm/pg-core";
import { user } from "./schema.ts";
export const todo = pgTable(
  "todo",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text().notNull(),
    done: boolean().notNull().default(false),
  },
  (table) => [index("todo_owner_id").on(table.ownerId)],
);
