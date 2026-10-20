import { createServer, type Socket } from "node:net";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { mail, smtpUrl, mailFrom, mailSendTimeout } from "~/components/mail/index.server";

test("public mail total deadline ends a slow-progress send and closes its socket", async () => {
  const sockets = new Set<Socket>();
  const peerClosed = Promise.withResolvers<void>();

  const timers = new Set<ReturnType<typeof setInterval>>();

  const server = createServer((socket) => {
    sockets.add(socket);

    socket.on("error", () => {});

    socket.on("close", () => {
      sockets.delete(socket);
      peerClosed.resolve();
    });

    socket.write("220 proof SMTP\r\n");

    socket.once("data", () => {
      const timer = setInterval(() => socket.write("250-still working\r\n"), 10);

      timers.add(timer);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");

  const root = createScope({
    tags: [
      smtpUrl(new URL(`smtp://127.0.0.1:${address.port}`)),
      mailFrom("proof@example.test"),
      mailSendTimeout(100),
    ],
  });

  let watchdog: ReturnType<typeof setTimeout> | undefined;

  let pending: Promise<unknown> | undefined;
  let closeWatchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    await root.ready;

    const sender = await root.resolve(mail);

    pending = sender
      .send({ to: "proof@example.test", subject: "No message sent", text: "Never reaches DATA" })
      .then(
        () => "sent",
        (error) => error,
      );

    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve("outside-deadline"), 700);
      }),
    ]);

    expect(result, "mail total deadline must end slow-progress send").not.toBe("outside-deadline");

    expect(result).toBeInstanceOf(Error);

    expect(String(result)).toContain("total timeout");

    const closed =
      sockets.size === 0 ||
      (await Promise.race([
        peerClosed.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          closeWatchdog = setTimeout(() => resolve(false), 500);
        }),
      ]));
    expect(closed, "active SMTP socket must close at total deadline").toBe(true);
  } finally {
    clearTimeout(watchdog);
    clearTimeout(closeWatchdog);

    for (const timer of timers) clearInterval(timer);

    for (const socket of sockets) socket.destroy();

    await root.close();

    await pending;

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
