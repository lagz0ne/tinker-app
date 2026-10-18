import { sql } from "drizzle-orm";
import { pgTable, bigserial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

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
