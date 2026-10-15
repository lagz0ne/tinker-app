import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  primaryKey,
  check,
  smallint,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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

export const issue = pgTable(
  "issue",
  {
    id: uuid().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    state: text({ enum: ["backlog", "todo", "in_progress", "done", "canceled"] })
      .notNull()
      .default("backlog"),
    priority: smallint().notNull().default(0),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id),
    rank: text().notNull(),
    version: integer().notNull().default(1),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [
    uniqueIndex("issue_team_number").on(row.teamId, row.number),
    uniqueIndex("issue_team_external_id").on(row.teamId, row.externalId),
    check(
      "issue_state",
      sql`${row.state} in ('backlog', 'todo', 'in_progress', 'done', 'canceled')`,
    ),
    check("issue_priority", sql`${row.priority} between 0 and 4`),
  ],
);

export const issueFields = {
  id: issue.id,
  teamId: issue.teamId,
  teamKey: team.key,
  number: issue.number,
  title: issue.title,
  description: issue.description,
  state: issue.state,
  priority: issue.priority,
  assigneeId: issue.assigneeId,
  creatorId: issue.creatorId,
  rank: issue.rank,
  version: issue.version,
};
