import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";
import { mailOutbox } from "~/components/mail/index.server";

import { issue, team, teamMember } from "./board.schema.server";

/** Daily UTC hour; a later restart catches up for today, never for missed days. */
export const digestHourUTC = tag<number>({
  label: "digest.hourUTC",
  default: 9,
  parse: z.number().int().min(0).max(23),
});

/** Scope-owned day gate; durable receipts still cover other workers and restarts. */
export const digestDone = resource({
  label: "digest.done",
  factory: async () => ({ day: "" }),
});

/** One SQL snapshot applies membership and queues one digest per user across all their teams. */
export const queueDailyDigests = operation({
  label: "digest.tick",
  depends: { database, orm: drizzleOrm, hour: digestHourUTC, done: digestDone },
  run: async ({ database, orm, hour, done }, { clock, log }) => {
    const now = new Date(clock.currentTimeMillis());
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < hour || done.day === day) return { queued: 0 };
    const { sql } = orm;

    const inserted = await database.execute(sql`
      INSERT INTO ${mailOutbox} ("to", subject, text, dedupe_key, next_at)
      SELECT ${user.email}, ${`Daily issue digest ${day}`},
        ${`Open issues for ${day} (UTC)\n\n`} ||
        array_to_string((array_agg(${team.key} || '-' || ${issue.number}::text || ' · ' || ${issue.title} ||
          ' [' || ${issue.state} || '], priority ' || ${issue.priority}::text
          ORDER BY ${team.key} COLLATE "C", ${issue.number}))[1:50], E'\n') ||
        CASE WHEN count(*) > 50 THEN E'\nAnd ' || (count(*) - 50)::text || ' more open issues.' ELSE '' END,
        'digest:' || ${user.id} || ':' || ${day}, ${now}
      FROM ${user}
      INNER JOIN ${teamMember} ON ${teamMember.userId} = ${user.id}
      INNER JOIN ${team} ON ${team.id} = ${teamMember.teamId}
      INNER JOIN ${issue} ON ${issue.teamId} = ${team.id}
      WHERE ${issue.state} NOT IN ('done', 'canceled')
        AND NOT EXISTS (
          SELECT 1 FROM ${mailOutbox}
          WHERE ${mailOutbox.dedupeKey} = 'digest:' || ${user.id} || ':' || ${day}
        )
      GROUP BY ${user.id}, ${user.email}
      ORDER BY ${user.id} COLLATE "C"
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    const queued = z.object({ rows: z.array(z.unknown()) }).parse(inserted).rows.length;
    done.day = day;
    log("digest.completed", { day, queued });
    return { queued };
  },
});

/** Failed snapshots wait thirty seconds even when notifications keep arriving. */
export const digestRetry = resource({
  label: "digest.retry",
  factory: async () => ({ at: 0 }),
});

export const tickMailDigest = operation({
  label: "digest.workerTick",
  depends: { digest: queueDailyDigests.controller, retry: digestRetry },
  run: async ({ digest, retry }, { clock, signal, log }) => {
    if (clock.currentTimeMillis() < retry.at) return;
    try {
      await digest.run();
      retry.at = 0;
    } catch (error) {
      if (signal.aborted) return;
      retry.at = clock.currentTimeMillis() + 30_000;
      log.error("digest.failed", { error: String(error) });
    }
  },
});
