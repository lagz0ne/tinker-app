import { createScope, operation } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { database, migrate } from "~/components/database/index.server";
import { authMail, mail, mailOutbox, enqueueMail } from "~/components/mail/index.server";

import { proofDatabase } from "./presets";

test("auth enqueue commits durable rows before returning and does not send", async () => {
  let sends = 0;

  const root = createScope({
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async () => {
          sends++;
        },
      })),
    ],
  });

  await root.ready;

  try {
    await root.run(migrate);

    const sender = root.resolve(authMail);

    const message = { to: "receiver@example.com", subject: "Auth", text: "Link" };

    await sender.enqueue(message);

    await sender.enqueue(message);

    const rows = await (await root.resolve(database)).select().from(mailOutbox);

    expect(rows, "auth enqueue must commit durable rows").toHaveLength(2);

    expect(rows).toMatchObject([message, message]);

    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);

    expect(rows.every((row) => row.dedupeKey.startsWith("mail:"))).toBe(true);

    expect(sends).toBe(0);
  } finally {
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});

test("enqueue shares the caller transaction and rolls back with its failed write", async () => {
  const root = createScope({ presets: [proofDatabase] });

  await root.ready;

  try {
    await root.run(migrate);

    const refuse = operation({
      label: "proof.refusedEnqueue",
      depends: { enqueue: enqueueMail },
      run: async ({ enqueue }, { raise }) => {
        await enqueue.run({
          input: { to: "proof@example.test", subject: "Rollback", text: "No mail" },
        });

        raise("Refused", {});
      },
    });

    const result = await root.settle(refuse, { signal: new AbortController().signal });

    expect(result.status).toBe("failed");

    expect(await (await root.resolve(database)).select().from(mailOutbox)).toEqual([]);
  } finally {
    await root.close();
  }
});
