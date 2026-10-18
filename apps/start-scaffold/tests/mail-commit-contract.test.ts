import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { database, migrate } from "~/components/database/index.server";
import { deliverMailBatch, mail, mailOutbox } from "~/components/mail/index.server";

import { proofDatabase, transactionQueries } from "./presets";

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
