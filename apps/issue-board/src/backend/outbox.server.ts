import { operation, resource } from "@tinker/core";

import { database, databaseUrl, drizzleOrm } from "~/components/database/index.server";
import { mail } from "~/components/mail/index.server";

import { mailOutbox } from "./board.schema.server";
import { postgres } from "./modules";

/** SMTP runs while the row is locked; another worker skips this batch. */
export const deliverMailBatch = operation({
  label: "outbox.deliverBatch",
  depends: { database, orm: drizzleOrm, mail },
  run: async ({ database, orm, mail }, { clock, log }) => {
    const { and, eq, lte, isNull, asc } = orm;
    return database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(mailOutbox)
        .where(
          and(
            isNull(mailOutbox.sentAt),
            lte(mailOutbox.nextAt, new Date(clock.currentTimeMillis())),
          ),
        )
        .orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))
        .limit(20)
        .for("update", { skipLocked: true });
      let sent = 0;
      for (const row of rows) {
        try {
          await mail.send({ to: row.to, subject: row.subject, text: row.text });
        } catch (error) {
          await tx
            .update(mailOutbox)
            .set({
              attempts: row.attempts + 1,
              nextAt: new Date(
                clock.currentTimeMillis() +
                  Math.min(1_800_000, 1000 * 2 ** Math.min(row.attempts, 11)),
              ),
              lastError: String(error).slice(0, 1000),
            })
            .where(eq(mailOutbox.id, row.id));
          log.error("outbox.retry", { id: row.id, attempts: row.attempts + 1 });
          continue;
        }
        await tx
          .update(mailOutbox)
          .set({
            attempts: row.attempts + 1,
            sentAt: new Date(clock.currentTimeMillis()),
            lastError: null,
          })
          .where(eq(mailOutbox.id, row.id));
        sent += 1;
      }
      return { claimed: rows.length, sent, failed: rows.length - sent };
    });
  },
});

/** LISTEN belongs to this resource; its private flag remembers wakes during a send. */
export const outboxWake = resource({
  label: "outbox.wake",
  depends: { url: databaseUrl, postgres },
  factory: async ({ url, postgres }, { clock, closing, defer }) => {
    let client: InstanceType<typeof postgres.default.Client> | undefined;
    let disconnected = false;
    let dirty = false;
    let waiting: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    defer(async () => {
      await client?.end();
    });

    const wake = {
      async listen() {
        if (client && !disconnected) return;

        await client?.end();
        client = new postgres.default.Client({ connectionString: url.href });
        disconnected = false;
        client.on("notification", () => {
          dirty = true;
          waiting?.resolve();
        });
        client.on("error", () => {
          disconnected = true;
          waiting?.resolve();
        });
        client.on("end", () => {
          disconnected = true;
          waiting?.resolve();
        });
        try {
          await client.connect();
          await client.query("LISTEN board_outbox");
        } catch (error) {
          disconnected = true;
          throw error;
        }
      },
      async wait() {
        if (dirty) {
          dirty = false;
          return;
        }

        const stop = new AbortController();
        waiting = Promise.withResolvers<void>();
        const tick = clock.sleep(30_000, AbortSignal.any([closing, stop.signal])).catch((error) => {
          if (!stop.signal.aborted && !closing.aborted) throw error;
        });

        try {
          await Promise.race([waiting.promise, tick]);
        } finally {
          waiting = undefined;
          stop.abort();
          await tick;
        }
        dirty = false;
      },
    };
    return wake;
  },
});

export const runMailWorker = operation({
  label: "outbox.worker",
  depends: { deliver: deliverMailBatch.controller, wake: outboxWake },
  run: async ({ deliver, wake }, { signal, log }) => {
    while (!signal.aborted) {
      try {
        await wake.listen();
        const result = await deliver.run();
        log("outbox.batch", result);
        if (result.claimed === 20) continue;
      } catch (error) {
        if (signal.aborted) return;
        log.error("outbox.unavailable", { error: String(error) });
      }
      await wake.wait();
    }
  },
});
