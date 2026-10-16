import { operation, resource, tag } from "@tinker/core";

import {
  transaction,
  databaseUrl,
  drizzleOrm,
  databaseConnectTimeout,
} from "~/components/database/index.server";

import { alertMail } from "./alert-mail.server";
import { mailOutbox } from "./board.schema.server";
import { tickMailDigest } from "./digest.server";
import { postgres } from "./modules";

/** Soft process stop: finish and commit the current SMTP send before closing the root. */
export const mailWorkerStop = tag<AbortSignal | undefined>({
  label: "outbox.stop",
  default: undefined,
});

/** SMTP runs while the row is locked; another worker skips this batch. */
export const deliverMailBatch = operation({
  label: "outbox.deliverBatch",
  depends: { tx: transaction, orm: drizzleOrm, mail: alertMail, stopping: mailWorkerStop },
  run: async ({ tx, orm, mail, stopping }, { clock, log, signal: contextSignal }) => {
    const signal = stopping ?? contextSignal;
    const { and, eq, lt, lte, isNull, asc } = orm;
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
  },
});

/** LISTEN belongs to this resource; its private flag remembers wakes during a send. */
export const outboxWake = resource({
  label: "outbox.wake",
  depends: {
    url: databaseUrl,
    postgres,
    stopping: mailWorkerStop,
    timeout: databaseConnectTimeout,
  },
  factory: async ({ url, postgres, stopping, timeout }, { clock, random, closing, defer, log }) => {
    const ending = stopping ? AbortSignal.any([closing, stopping]) : closing;
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
          connectionTimeoutMillis: timeout,
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

        ending.throwIfAborted();

        const cancelled = Promise.withResolvers<never>();

        const abort = () => {
          void next.end().catch(() => {});

          cancelled.reject(ending.reason);
        };

        ending.addEventListener("abort", abort, { once: true });

        try {
          await Promise.race([
            Promise.resolve().then(async () => {
              await next.connect();

              await next.query("LISTEN board_outbox");
            }),
            cancelled.promise,
          ]);

          ending.throwIfAborted();

          connected = true;
        } finally {
          ending.removeEventListener("abort", abort);
        }
      },
      async retry() {
        // A failed connect must wait on the timer alone, never an old client's end event.
        const delay = Math.floor(
          Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) * (0.5 + random.next() / 2),
        );
        failures += 1;
        log("outbox.reconnect", { attempt: failures, delay });
        await clock.sleep(delay, ending).catch((error) => {
          if (!ending.aborted) throw error;
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
        const tick = clock.sleep(30_000, AbortSignal.any([ending, stop.signal])).catch((error) => {
          if (!stop.signal.aborted && !ending.aborted) throw error;
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

/** Native worker integration: one child per claimed batch, with soft-stop commit. */
export const runMailPass = operation({
  label: "outbox.pass",
  depends: {
    deliver: deliverMailBatch.controller,
    digest: tickMailDigest.controller,
    stopping: mailWorkerStop,
  },
  run: async ({ deliver, digest, stopping }, { signal: contextSignal, log }) => {
    const signal = stopping ?? contextSignal;
    await digest.run();
    if (signal.aborted) return;
    let result;
    do {
      const delivered = await deliver.settle({ signal: contextSignal });
      if (delivered.status === "failed") throw delivered.error;
      if (delivered.status === "cancelled") return;
      result = delivered.value;
      log("outbox.batch", result);
    } while (result.claimed === 20 && !signal.aborted);
  },
});

export const runMailWorker = operation({
  label: "outbox.worker",
  depends: { pass: runMailPass.controller, wake: outboxWake, stopping: mailWorkerStop },
  run: async ({ pass, wake, stopping }, { signal: contextSignal, log }) => {
    const signal = stopping ?? contextSignal;
    while (!signal.aborted) {
      try {
        await wake.listen();
        await pass.run();
      } catch (error) {
        if (signal.aborted) return;
        log.error("outbox.unavailable", { error: String(error) });
        await wake.retry();
        continue;
      }
      if (!signal.aborted) await wake.wait();
    }
  },
});
