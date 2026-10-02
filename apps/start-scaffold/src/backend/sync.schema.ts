import { pgTable, integer } from "drizzle-orm/pg-core";
export { stream, execution, event } from "../scaffold/backend/sync.schema.ts";
export const counter = pgTable("public_counter", {
  id: integer().primaryKey(),
  value: integer().notNull().default(0),
});
