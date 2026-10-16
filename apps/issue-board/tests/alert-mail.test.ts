import { createServer, type Socket } from "node:net";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { database, migrate } from "~/components/database/index.server";
import { smtpUrl, mailFrom } from "~/components/mail/index.server";

import { alertMailTimeout } from "@/backend/alert-mail.server";
import { mailOutbox } from "@/backend/board.schema.server";
import { deliverMailBatch } from "@/backend/outbox.server";

import { proofDatabase } from "./presets";

test("a local endpoint that never greets times out and releases the claim", async () => {
  const sockets = new Set<Socket>();
  let bytes = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (data) => {
      bytes += data.length;
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local endpoint");

  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    presets: [proofDatabase],
    tags: [
      smtpUrl(new URL(`smtp://127.0.0.1:${address.port}`)),
      mailFrom("board@example.test"),
      alertMailTimeout(50),
    ],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const db = await root.resolve(database);
    await db.insert(mailOutbox).values({
      to: "member@example.test",
      subject: "Hung greeting",
      text: "Never sent",
      dedupeKey: "timeout",
      nextAt: new Date(0),
    });

    expect(await root.run(deliverMailBatch)).toEqual({ claimed: 1, sent: 0, failed: 1 });
    const [row] = await db.select().from(mailOutbox);
    expect(row).toMatchObject({ attempts: 1, sentAt: null });
    expect(row!.lastError).toMatch(/timeout|greeting/i);
    expect(bytes).toBe(0);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
