import { createScope, operation } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { expect, test } from "vite-plus/test";

import { database, leaseFrom, migrate, type Database } from "~/components/database/index.server";
import {
  claimMailBatch,
  acknowledgeMail,
  releaseMailClaims,
  enqueueMail,
  deliverMailBatch,
  mail,
  mailOutbox,
} from "~/components/mail/index.server";

import { proofDatabase, transactionQueries } from "./presets";
import { write } from "./write-boundary";

for (const refused of [false, true]) {
  test(`delivery commits its claim before SMTP and its ${refused ? "failure" : "success"} ack before returning`, async () => {
    const root = createScope({
      clock: makeTestClock({ now: 10000 }),
      presets: [
        proofDatabase,
        preset(mail, async () => ({
          send: async () => {
            expect(
              transactionQueries,
              "claim must commit before send, with no open transaction",
            ).toEqual(["BEGIN", "COMMIT"]);
            if (refused) throw new Error("SMTP refused");
          },
        })),
      ],
    });
    try {
      await root.run(migrate);
      const db = await root.resolve(database);
      await db.insert(mailOutbox).values({
        to: "receiver@example.test",
        subject: "Owned call",
        text: "Body",
        dedupeKey: "commit-proof",
        nextAt: new Date(0),
      });
      transactionQueries.length = 0;

      expect(await root.run(deliverMailBatch, { signal: new AbortController().signal })).toEqual({
        claimed: 1,
        sent: refused ? 0 : 1,
        failed: refused ? 1 : 0,
      });
      expect(transactionQueries, "ack must commit before progress can be reported").toEqual([
        "BEGIN",
        "COMMIT",
        "BEGIN",
        "COMMIT",
      ]);
      expect((await db.select().from(mailOutbox))[0]).toMatchObject({
        leaseToken: null,
        leaseUntil: null,
        lastError: refused ? "Error: SMTP refused" : null,
      });
    } finally {
      await root.close({ graceful: true });
    }
  });
}

for (const kind of ["claim", "acknowledge", "release", "enqueue", "delivery"] as const) {
  test(`${kind} fails on COMMIT, rolls back once and retires its checked-out client`, async () => {
    const error = new Error("mail COMMIT refused");
    const queries: string[] = [];
    const releases: (boolean | undefined)[] = [];
    const kept: Database.Transaction[] = [];
    let acquired = 0;
    let sends = 0;
    const client = {
      query: async (config: string | { text: string }) => {
        const text = typeof config === "string" ? config : config.text;
        queries.push(text);
        if (text === "COMMIT") throw error;
        return { rows: text.includes('returning "attempts"') ? [[1]] : [], rowCount: 0 };
      },
      release: (broken?: boolean) => {
        releases.push(broken);
      },
    } as unknown as PoolClient;
    const root = createScope({
      presets: [
        preset(database, async () =>
          Object.assign(drizzle({ client }), {
            listen: async () => () => {},
            checkout: async (guard?: Database.QueryGuard) => {
              const lease = leaseFrom(
                async () => {
                  acquired++;
                  return client;
                },
                drizzle,
                guard,
              );
              kept.push(lease.db);
              return lease;
            },
          }),
        ),
        preset(mail, async () => ({
          send: async () => {
            sends++;
          },
        })),
        ...(kind === "delivery"
          ? [
              preset(claimMailBatch, async () => ({
                token: "lease",
                rows: [
                  {
                    id: 1,
                    to: "receiver@example.test",
                    subject: "Subject",
                    text: "Body",
                    leaseUntil: new Date(Date.now() + 180000),
                  },
                ] as (typeof mailOutbox.$inferSelect)[],
              })),
            ]
          : []),
      ],
    });
    const call = operation({
      label: `proof.mail.${kind}`,
      depends: {
        claim: claimMailBatch.controller,
        acknowledge: acknowledgeMail.controller,
        release: releaseMailClaims.controller,
        enqueue: enqueueMail.controller,
        delivery: deliverMailBatch.controller,
      },
      run: async ({ claim, acknowledge, release, enqueue, delivery }): Promise<unknown> => {
        if (kind === "claim") return claim.run();
        if (kind === "acknowledge") {
          return acknowledge.run({ input: { id: 1, token: "lease", error: null } });
        }
        if (kind === "release") return release.run({ input: { token: "lease" } });
        if (kind === "enqueue") {
          return enqueue.run({
            input: { to: "receiver@example.test", subject: "Subject", text: "Body" },
          });
        }
        return delivery.run();
      },
    });

    try {
      expect(acquired).toBe(0);
      const outcome = await write(root, call).then(
        (value) => ({ status: "success", value }),
        (error) => ({ status: "failed", error }),
      );
      expect(
        outcome,
        "failed mail COMMIT must fail its call without reporting success",
      ).toMatchObject({
        status: "failed",
        error: { kind: "TeardownFailed", payload: { causes: [error] } },
      });

      expect(queries.filter((query) => query === "COMMIT")).toHaveLength(1);
      expect(queries.filter((query) => query === "ROLLBACK")).toHaveLength(1);
      expect(acquired).toBe(1);
      expect(releases).toEqual([true]);
      expect(sends).toBe(kind === "delivery" ? 1 : 0);
      for (const tx of kept) {
        await expect(tx.execute(sql`SELECT 1`)).rejects.toMatchObject({ kind: "TransactionEnded" });
      }
    } finally {
      await root.close();
    }
  });
}
