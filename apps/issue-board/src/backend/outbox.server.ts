import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import {
  transaction,
  databaseUrl,
  drizzleOrm,
  databaseConnectTimeout,
} from "~/components/database/index.server";
import { mail as alertMail } from "~/components/mail/index.server";

import { mailOutbox } from "./board.schema.server";
import { tickMailDigest } from "./digest.server";
import { postgres } from "./modules";

/** Soft process stop: finish and commit the current SMTP send before closing the root. */
export const mailWorkerStop = tag<AbortSignal | undefined>({
  label: "outbox.stop",
  default: undefined,
});

/** A batch lease covers all twenty bounded sends and their acknowledgements. */
export const mailLeaseMs = tag<number>({
  label: "outbox.leaseMs",
  default: 180000,
  parse: z.number().int().min(1000).max(3600000),
});

export const claimMailBatch = operation({
  label: "outbox.claim",
  depends: { tx: transaction, orm: drizzleOrm, lease: mailLeaseMs },
  run: async ({ tx, orm, lease }, { clock, random }) => {
    const { and, or, lt, lte, isNull, asc, inArray, sql } = orm;
    const now = new Date(clock.currentTimeMillis());
    const available = or(isNull(mailOutbox.leaseUntil), lte(mailOutbox.leaseUntil, now));
    await tx
      .update(mailOutbox)
      .set({ deadAt: now, leaseToken: null, leaseUntil: null })
      .where(
        and(
          isNull(mailOutbox.sentAt),
          isNull(mailOutbox.deadAt),
          available,
          sql`${mailOutbox.attempts} >= 12`,
        ),
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
      .set({ leaseToken: null, leaseUntil: null })
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
  },
  run: async ({ claim, ack, release, mail, stopping }, { signal: contextSignal }) => {
    const signal = stopping ?? contextSignal;
    const { token, rows } = await claim.run({ signal: contextSignal });

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      if (signal.aborted) break;

      let error: string | null = null;

      try {
        await mail.send({ to: row.to, subject: row.subject, text: row.text });
      } catch (cause) {
        error = String(cause).slice(0, 1000);
      }
      const saved = await ack.run({ input: { id: row.id, token, error }, signal: contextSignal });

      if (!saved.acknowledged) continue;

      if (error === null) sent++;
      else failed++;
    }
    if (signal.aborted) {
      await release.run({ input: { token }, signal: contextSignal });
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
