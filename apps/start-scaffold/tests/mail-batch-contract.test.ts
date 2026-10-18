import { createScope, type Observe } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { expect, test } from "vite-plus/test";

import {
  databaseConnectTimeout,
  databaseStatementTimeout,
  transaction,
  type Database,
} from "~/components/database/index.server";
import {
  acknowledgeMail,
  claimMailBatch,
  deliverMailBatch,
  mail,
  mailOutbox,
  mailSendTimeout,
  mailWorkerStop,
  releaseMailClaims,
} from "~/components/mail/index.server";

test("claim uses one bounded SKIP LOCKED statement for both due and dead rows", async () => {
  const queries: { text: string; values?: unknown[] }[] = [];
  const root = createScope({
    presets: [
      preset(
        transaction,
        async () =>
          Object.assign(
            drizzle({
              client: {
                query: async (config: { text: string; values?: unknown[] }, values?: unknown[]) => {
                  queries.push({ ...config, values });
                  return { rows: [] };
                },
              } as unknown as PoolClient,
            }),
            { commit: async () => {}, rollback: async () => {} },
          ) as Database.SessionTransaction,
      ),
    ],
  });
  try {
    const batch = await root.run(claimMailBatch);

    expect(batch.rows).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text.match(/for update skip locked/g)).toHaveLength(2);
    expect(queries[0]!.text.match(/limit /g)).toHaveLength(2);
    expect(queries[0]!.values?.filter((value) => value === 20)).toHaveLength(2);
    expect(queries[0]!.text).toContain('"attempts" + 1');
    expect(queries[0]!.text).toContain('"attempts" >= 12');
    expect(queries[0]!.text).toContain('"lease_token" =');
    expect(queries[0]!.text).toContain('"lease_until" =');
  } finally {
    await root.close();
  }
});

for (const remaining of [5999, 6000, 6001]) {
  test(`delivery reserves send plus ack budget at remaining lease ${remaining}`, async () => {
    const clock = makeTestClock({ now: 10000 });
    const sends: unknown[] = [];
    const acks: unknown[] = [];
    const releases: unknown[] = [];
    const row = {
      id: 7,
      to: "account@example.test",
      subject: "Subject",
      text: "Body",
      leaseUntil: new Date(10000 + remaining),
    } as typeof mailOutbox.$inferSelect;
    const root = createScope({
      clock,
      tags: [mailSendTimeout(3000), databaseConnectTimeout(500), databaseStatementTimeout(750)],
      presets: [
        preset(claimMailBatch, async () => ({ token: "lease-7", rows: [row] })),
        preset(acknowledgeMail, async (_deps, { input }) => {
          acks.push(input);
          return { acknowledged: true };
        }),
        preset(releaseMailClaims, async (_deps, { input }) => {
          releases.push(input);
        }),
        preset(mail, async () => ({
          send: async (message: { to: string; subject: string; text: string }) => {
            sends.push(message);
          },
        })),
      ],
    });

    try {
      expect(await root.run(deliverMailBatch)).toEqual({
        claimed: 1,
        sent: remaining >= 6000 ? 1 : 0,
        failed: 0,
      });
      expect(sends).toEqual(
        remaining >= 6000 ? [{ to: row.to, subject: row.subject, text: row.text }] : [],
      );
      expect(acks).toEqual(remaining >= 6000 ? [{ id: 7, token: "lease-7", error: null }] : []);
      expect(releases).toEqual(remaining >= 6000 ? [] : [{ token: "lease-7" }]);
    } finally {
      await root.close();
    }
  });
}

for (const acknowledged of [true, false]) {
  test(`delivery clips errors and counts only token-fenced acknowledgements: ${acknowledged}`, async () => {
    const acks: unknown[] = [];
    const rows = [1, 2].map(
      (id) =>
        ({
          id,
          to: "account@example.test",
          subject: "Subject",
          text: "Body",
          leaseUntil: new Date(180000),
        }) as typeof mailOutbox.$inferSelect,
    );
    let sends = 0;
    const error = "refused:" + "x".repeat(1100);
    const root = createScope({
      clock: makeTestClock(),
      presets: [
        preset(claimMailBatch, async () => ({ token: "lease", rows })),
        preset(acknowledgeMail, async (_deps, { input }) => {
          acks.push(input);
          return { acknowledged };
        }),
        preset(releaseMailClaims, async () => {
          throw new Error("must not release an attempted send");
        }),
        preset(mail, async () => ({
          send: async () => {
            if (++sends === 2) throw error;
          },
        })),
      ],
    });

    try {
      expect(await root.run(deliverMailBatch)).toEqual({
        claimed: 2,
        sent: Number(acknowledged),
        failed: Number(acknowledged),
      });
      expect(acks).toEqual([
        { id: 1, token: "lease", error: null },
        { id: 2, token: "lease", error: error.slice(0, 1000) },
      ]);
    } finally {
      await root.close();
    }
  });
}

test("a pre-stopped soft worker refunds its full batch without sends or acknowledgements", async () => {
  const stop = new AbortController();
  stop.abort();
  const releases: unknown[] = [];
  let sends = 0;
  let acks = 0;
  const row = { leaseUntil: new Date(180000) } as typeof mailOutbox.$inferSelect;
  const root = createScope({
    clock: makeTestClock(),
    tags: [mailWorkerStop(stop.signal)],
    presets: [
      preset(claimMailBatch, async () => ({ token: "refund", rows: [row] })),
      preset(acknowledgeMail, async () => {
        acks++;
        return { acknowledged: true };
      }),
      preset(releaseMailClaims, async (_deps, { input }) => {
        releases.push(input);
      }),
      preset(mail, async () => ({
        send: async () => {
          sends++;
        },
      })),
    ],
  });

  try {
    expect(await root.run(deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 0 });
    expect(releases).toEqual([{ token: "refund" }]);
    expect(sends).toBe(0);
    expect(acks).toBe(0);
  } finally {
    await root.close();
  }
});

for (const [attempts, error, found] of [
  [11, "refused", true],
  [12, "refused", true],
  [12, null, true],
  [12, "stale", false],
] as const) {
  test(`mail ack logs only an owned failed attempt: ${attempts}/${error}/${found}`, async () => {
    const logs: Observe.Log[] = [];
    const queries: { text: string; values: unknown[] }[] = [];
    const root = createScope({
      clock: makeTestClock({ now: 10000 }),
      observe: { history: 10, log: (entry) => logs.push(entry) },
      presets: [
        preset(
          transaction,
          async () =>
            Object.assign(
              drizzle({
                client: {
                  query: async (config: { text: string }, values: unknown[]) => {
                    queries.push({ text: config.text, values });
                    return { rows: found ? [[attempts]] : [] };
                  },
                } as unknown as PoolClient,
              }),
              { commit: async () => {}, rollback: async () => {} },
            ) as Database.SessionTransaction,
        ),
      ],
    });
    try {
      expect(
        await root.run(acknowledgeMail, { input: { id: 7, token: "lease-7", error } }),
      ).toEqual({ acknowledged: found });
      const errors = logs.filter(
        (entry) => entry.message === "outbox.dead" || entry.message === "outbox.retry",
      );

      expect(errors).toMatchObject(
        found && error !== null
          ? [
              {
                message: attempts === 12 ? "outbox.dead" : "outbox.retry",
                attributes: { id: 7, attempts },
              },
            ]
          : [],
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain('"mail_outbox"."id" =');
      expect(queries[0]!.text).toContain('"mail_outbox"."lease_token" =');
      expect(queries[0]!.values).toContain("lease-7");
      expect(queries[0]!.values).toContain(7);
      if (error !== null) expect(queries[0]!.values).toContain(error);
    } finally {
      await root.close();
    }
  });
}
