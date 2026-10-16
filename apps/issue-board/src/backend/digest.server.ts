import { operation, tag } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";

import { issue, mailOutbox, team, teamMember } from "./board.schema.server";

/** Daily UTC hour; a later restart catches up for today, never for missed days. */
export const digestHourUTC = tag<number>({
  label: "digest.hourUTC",
  default: 9,
  parse: z.number().int().min(0).max(23),
});

/** One SQL snapshot applies membership and queues one digest per user across all their teams. */
export const queueDailyDigests = operation({
  label: "digest.tick",
  depends: { database, orm: drizzleOrm, hour: digestHourUTC },
  run: async ({ database, orm, hour }, { clock, log }) => {
    const now = new Date(clock.currentTimeMillis());
    if (now.getUTCHours() < hour) return { queued: 0 };
    const day = now.toISOString().slice(0, 10);
    const { sql } = orm;

    const inserted = await database.execute(sql`
      INSERT INTO ${mailOutbox} ("to", subject, text, dedupe_key, next_at)
      SELECT ${user.email}, ${`Daily issue digest ${day}`},
        ${`Open issues for ${day} (UTC)\n\n`} ||
        string_agg(${team.key} || '-' || ${issue.number}::text || ' · ' || ${issue.title} ||
          ' [' || ${issue.state} || '], priority ' || ${issue.priority}::text,
          E'\n' ORDER BY ${team.key} COLLATE "C", ${issue.number}),
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
    log("digest.queued", { day, queued });
    return { queued };
  },
});
