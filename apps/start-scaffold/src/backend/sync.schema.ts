import { pgTable, integer } from "drizzle-orm/pg-core";
export const counter = pgTable("public_counter", {
  id: integer().primaryKey(),
  value: integer().notNull().default(0),
});
