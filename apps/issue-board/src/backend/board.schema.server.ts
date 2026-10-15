import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, primaryKey, check } from "drizzle-orm/pg-core";

import { user } from "~/components/auth/index.server";

export const team = pgTable("team", {
  id: uuid().primaryKey(),
  key: text().notNull().unique(),
  name: text().notNull(),
  issueSeq: integer("issue_seq").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMember = pgTable(
  "team_member",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text().$type<"admin" | "member">().notNull(),
  },
  (row) => [
    primaryKey({ columns: [row.teamId, row.userId] }),
    check("team_member_role", sql`${row.role} in ('admin', 'member')`),
  ],
);
