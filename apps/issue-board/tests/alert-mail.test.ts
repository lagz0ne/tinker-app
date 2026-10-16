import { createServer, type Socket } from "node:net";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { database, migrate } from "~/components/database/index.server";
import { smtpUrl, mailFrom } from "~/components/mail/index.server";

import { alertMail, alertMailTimeout } from "@/backend/alert-mail.server";
import { mailOutbox } from "@/backend/board.schema.server";
import { smtp } from "@/backend/modules";
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

test("SMTP URL options keep credentials, IPv6, TLS and no-auth settings", async () => {
  for (const [url, expected] of [
    [
      "smtp://digest%2Duser:p%40ss@[::1]:465",
      { host: "::1", port: 465, secure: true, auth: { user: "digest-user", pass: "p@ss" } },
    ],
    ["smtp://127.0.0.1:11026", { host: "127.0.0.1", port: 11026, secure: false, auth: undefined }],
    ["smtps://localhost", { host: "localhost", port: undefined, secure: true, auth: undefined }],
  ] as const) {
    const options: unknown[] = [];
    const stop = new AbortController();
    const root = createScope({
      signal: stop.signal,
      tags: [smtpUrl(new URL(url)), mailFrom("board@example.test")],
      presets: [
        preset(
          smtp,
          async () =>
            ({
              default: {
                createTransport: (value: unknown) => {
                  options.push(value);
                  return { close: () => {}, sendMail: async () => {} };
                },
              },
            }) as never,
        ),
      ],
    });
    try {
      await root.ready;
      await root.resolve(alertMail);
      expect(options).toEqual([expect.objectContaining(expected)]);
    } finally {
      stop.abort();
      expect((await root.closed).status).toBe("success");
    }
  }
});
