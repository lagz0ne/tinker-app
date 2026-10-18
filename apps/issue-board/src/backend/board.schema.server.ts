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
  index,
  bigserial,
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

export const issueRowFields = {
  id: issue.id,
  teamId: issue.teamId,
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

export const issueFields = { ...issueRowFields, teamKey: team.key };

export const comment = pgTable(
  "comment",
  {
    id: uuid().primaryKey(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (row) => [
    // Use the same whitespace set as JavaScript String.trim().
    check(
      "comment_body",
      sql`char_length(${row.body}) between 1 and 5000 and ${row.body} = btrim(${row.body}, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')`,
    ),
    index("comment_issue_created").on(row.issueId, row.createdAt, row.id),
  ],
);

export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    to: text().notNull(),
    subject: text().notNull(),
    text: text().notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    attempts: integer().notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    deadAt: timestamp("dead_at", { withTimezone: true }),
  },
  (row) => [
    index("mail_outbox_due")
      .on(row.nextAt, row.id)
      .where(sql`${row.sentAt} is null and ${row.attempts} < 12`),
  ],
);
