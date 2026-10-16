import { operation, resource } from "@tinker/core";

import { database, databaseUrl, drizzleOrm } from "~/components/database/index.server";

import { alertMail } from "./alert-mail.server";
import { mailOutbox } from "./board.schema.server";
import { postgres } from "./modules";

/** SMTP runs while the row is locked; another worker skips this batch. */
export const deliverMailBatch = operation({
  label: "outbox.deliverBatch",
  depends: { database, orm: drizzleOrm, mail: alertMail },
  run: async ({ database, orm, mail }, { clock, log, signal }) => {
    const { and, eq, lt, lte, isNull, asc } = orm;
    return database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(mailOutbox)
        .where(
          and(
            isNull(mailOutbox.sentAt),
            lt(mailOutbox.attempts, 12),
            lte(mailOutbox.nextAt, new Date(clock.currentTimeMillis())),
          ),
        )
        .orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))
        .limit(20)
        .for("update", { skipLocked: true });
      let sent = 0;
      let failed = 0;
      for (const row of rows) {
        if (signal.aborted) break;

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
          failed += 1;
          log.error(row.attempts + 1 === 12 ? "outbox.dead" : "outbox.retry", {
            id: row.id,
            attempts: row.attempts + 1,
          });
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
      return { claimed: rows.length, sent, failed };
    });
  },
});

/** LISTEN belongs to this resource; its private flag remembers wakes during a send. */
export const outboxWake = resource({
  label: "outbox.wake",
  depends: { url: databaseUrl, postgres },
  factory: async ({ url, postgres }, { clock, random, closing, defer, log }) => {
    let client: InstanceType<typeof postgres.default.Client> | undefined;
    let connected = false;
    let dirty = false;
    let failures = 0;
    let waiting: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    defer(async () => {
      await client?.end();
    });

    return {
      async listen() {
        if (connected) return;

        const old = client;
        client = undefined;
        await old?.end();
        const next = new postgres.default.Client({
          connectionString: url.href,
          connectionTimeoutMillis: 10_000,
        });
        client = next;
        next.on("error", () => {
          if (client !== next || !connected) return;
          connected = false;
          waiting?.resolve();
        });
        next.on("end", () => {
          if (client !== next || !connected) return;
          connected = false;
          waiting?.resolve();
        });
        next.on("notification", () => {
          if (client !== next || !connected) return;
          dirty = true;
          waiting?.resolve();
        });
        await next.connect();
        await next.query("LISTEN board_outbox");
        connected = true;
      },
      async retry() {
        // A failed connect must wait on the timer alone, never an old client's end event.
        const delay = Math.floor(
          Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) * (0.5 + random.next() / 2),
        );
        failures += 1;
        log("outbox.reconnect", { attempt: failures, delay });
        await clock.sleep(delay, closing).catch((error) => {
          if (!closing.aborted) throw error;
        });
      },
      async wait() {
        // A drop during a batch must return to listen instead of losing the wake for 30 seconds.
        if (dirty || !connected) {
          dirty = false;
          return;
        }
        failures = 0;

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
        await wake.retry();
        continue;
      }
      await wake.wait();
    }
  },
});
