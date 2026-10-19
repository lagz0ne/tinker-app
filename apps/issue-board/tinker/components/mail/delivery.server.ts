import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import {
  transaction,
  database,
  drizzleOrm,
  databaseConnectTimeout,
  databaseStatementTimeout,
} from "~/components/database/index.server";

import { mail as alertMail } from "./mail.server";
import { mailOutbox } from "./schema.server";
import { mailSendTimeout } from "./settings";

/** Soft process stop: finish and commit the current SMTP send before closing the root. */
export const mailWorkerStop = tag<AbortSignal | undefined>({
  label: "outbox.stop",
  default: undefined,
});

/** A batch lease covers all twenty bounded sends and their acknowledgements. */
export const mailLeaseMs = tag<number>({
  label: "outbox.leaseMs",
  default: 180000,
  parse: z.number().int().min(120000).max(3600000),
});

export const claimMailBatch = operation({
  label: "outbox.claim",
  depends: { tx: transaction, orm: drizzleOrm, lease: mailLeaseMs },
  run: async ({ tx, orm, lease }, { clock, random }) => {
    const { and, or, lt, lte, isNull, asc, inArray, sql } = orm;
    const now = new Date(clock.currentTimeMillis());
    const available = or(isNull(mailOutbox.leaseUntil), lte(mailOutbox.leaseUntil, now));
    const exhaustedRows = tx
      .select({ id: sql`${mailOutbox.id}` })
      .from(mailOutbox)
      .where(
        and(
          isNull(mailOutbox.sentAt),
          isNull(mailOutbox.deadAt),
          available,
          sql`${mailOutbox.attempts} >= 12`,
        ),
      )
      .limit(20)
      .for("update", { skipLocked: true });
    const exhausted = tx
      .$with("outbox_exhausted")
      .as(
        tx
          .update(mailOutbox)
          .set({ deadAt: now, leaseToken: null, leaseUntil: null })
          .where(inArray(mailOutbox.id, exhaustedRows))
          .returning({ id: mailOutbox.id }),
      );

    const token = random.uuid();
    const due = tx
      .select({ id: sql`${mailOutbox.id}` })
      .from(mailOutbox)
      .where(
        and(
          isNull(mailOutbox.sentAt),
          isNull(mailOutbox.deadAt),
          available,
          lt(mailOutbox.attempts, 12),
          lte(mailOutbox.nextAt, now),
        ),
      )
      .orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))
      .limit(20)
      .for("update", { skipLocked: true });
    const rows = await tx
      .with(exhausted)
      .update(mailOutbox)
      .set({
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + lease),
        attempts: sql`${mailOutbox.attempts} + 1`,
      })
      .where(inArray(mailOutbox.id, due))
      .returning();
    return { token, rows };
  },
});

export const acknowledgeMail = operation({
  label: "outbox.acknowledge",
  input: z.object({ id: z.number(), token: z.string(), error: z.string().nullable() }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input, clock, log }) => {
    const { and, eq, sql } = orm;
    const now = new Date(clock.currentTimeMillis());
    const [row] = await tx
      .update(mailOutbox)
      .set({
        leaseToken: null,
        leaseUntil: null,
        sentAt: input.error === null ? now : null,
        lastError: input.error,
        nextAt:
          input.error === null
            ? now
            : sql`${now}::timestamptz + least(1800000, 1000 * power(2, least(${mailOutbox.attempts} - 1, 11))) * interval '1 millisecond'`,
        deadAt:
          input.error === null
            ? null
            : sql`CASE WHEN ${mailOutbox.attempts} >= 12 THEN ${now}::timestamptz ELSE NULL END`,
      })
      .where(and(eq(mailOutbox.id, input.id), eq(mailOutbox.leaseToken, input.token)))
      .returning({ attempts: mailOutbox.attempts });
    if (row && input.error !== null) {
      log.error(row.attempts === 12 ? "outbox.dead" : "outbox.retry", {
        id: input.id,
        attempts: row.attempts,
      });
    }
    return { acknowledged: !!row };
  },
});

export const releaseMailClaims = operation({
  label: "outbox.releaseClaims",
  input: z.object({ token: z.string() }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input }) => {
    await tx
      .update(mailOutbox)
      .set({ leaseToken: null, leaseUntil: null, attempts: orm.sql`${mailOutbox.attempts} - 1` })
      .where(orm.eq(mailOutbox.leaseToken, input.token));
  },
});

/** Native delivery integration: claim and ack each close before the next step. */
export const deliverMailBatch = operation({
  label: "outbox.deliverBatch",
  depends: {
    claim: claimMailBatch.controller,
    ack: acknowledgeMail.controller,
    release: releaseMailClaims.controller,
    mail: alertMail,
    stopping: mailWorkerStop,
    sendTimeout: mailSendTimeout,
    checkoutTimeout: databaseConnectTimeout,
    statementTimeout: databaseStatementTimeout,
  },
  run: async (
    { claim, ack, release, mail, stopping, sendTimeout, checkoutTimeout, statementTimeout },
    { signal: contextSignal, clock },
  ) => {
    const signal = stopping ?? contextSignal;
    const { token, rows } = await claim.run({ signal: contextSignal });

    // Reserve checkout, UPDATE and COMMIT bounds, plus setup/dispatch margin.
    const budget = sendTimeout + checkoutTimeout + 2 * statementTimeout + 1000;

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      if (signal.aborted || row.leaseUntil!.getTime() - clock.currentTimeMillis() < budget) {
        await release.run({ input: { token }, signal: contextSignal });
        break;
      }

      let error: string | null = null;

      try {
        await mail.send({ to: row.to, subject: row.subject, text: row.text });
      } catch (cause) {
        error = String(cause).slice(0, 1000);
      }
      const saved = await ack.run({ input: { id: row.id, token, error }, signal: contextSignal });

      if (!saved.acknowledged) continue;

      sent += Number(error === null);
      failed += Number(error !== null);
    }
    return { claimed: rows.length, sent, failed };
  },
});

/** LISTEN belongs to this resource; its private flag remembers wakes during a send. */
export const outboxWake = resource({
  label: "outbox.wake",
  depends: { database, stopping: mailWorkerStop },
  factory: async ({ database, stopping }, { clock, random, closing, defer, log }) => {
    const ending = stopping ? AbortSignal.any([closing, stopping]) : closing;
    let close: (() => void | Promise<void>) | undefined;
    let connected = false;
    let dirty = false;
    let failures = 0;
    let waiting: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    defer(async () => {
      await close?.();
    });

    return {
      async listen() {
        if (connected) return;

        await close?.();
        close = undefined;
        ending.throwIfAborted();
        close = await database.listen(
          "board_outbox",
          () => {
            dirty = true;
            waiting?.resolve();
          },
          () => {
            connected = false;
            waiting?.resolve();
          },
          ending,
        );
        connected = true;
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

const drainMailBatches = operation({
  label: "outbox.drain",
  depends: { deliver: deliverMailBatch.controller, stopping: mailWorkerStop },
  run: async ({ deliver, stopping }, { signal }) => {
    const stop = stopping ?? signal;
    let batch;

    do {
      const delivered = await deliver.settle({ signal });
      if (delivered.status === "failed") throw delivered.error;
      if (delivered.status === "cancelled") return;
      batch = delivered.value;
    } while (batch.claimed === 20 && !stop.aborted);
  },
});

export const runMailWorker = operation({
  label: "mail.worker",
  depends: { drain: drainMailBatches.controller, wake: outboxWake, stopping: mailWorkerStop },
  run: async ({ drain, wake, stopping }, { signal, log }) => {
    const stop = stopping ?? signal;
    while (!stop.aborted) {
      try {
        await wake.listen();
        const drained = await drain.settle({ signal });
        if (drained.status === "failed") throw drained.error;
        if (drained.status === "cancelled") return;
      } catch (error) {
        if (stop.aborted) return;
        log.error("outbox.unavailable", { error: String(error) });
        await wake.retry();
        continue;
      }
      if (!stop.aborted) await wake.wait();
    }
  },
});
