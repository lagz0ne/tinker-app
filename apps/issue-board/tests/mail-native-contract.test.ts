import { EventEmitter, getEventListeners } from "node:events";
import type { Socket } from "node:net";

import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import type { GetSocketCallback } from "nodemailer/lib/mailer";
import { expect, test } from "vite-plus/test";

import { mail, mailFrom, mailSendTimeout, smtpUrl } from "~/components/mail/index.server";
import { smtp, smtpNet } from "~/components/mail/modules";
import { smtpSockets } from "~/components/mail/sockets.server";

for (const [url, host, port] of [
  ["smtp://[::1]:2525", "::1", 2525],
  ["smtp://relay.test", "relay.test", 587],
  ["smtps://relay.test", "relay.test", 465],
] as const) {
  test(`SMTP socket ${url} owns connect, error, close, abort, and scope close`, async () => {
    const sockets: (EventEmitter & { destroy: (error?: Error) => void })[] = [];
    const destroyed: (Error | undefined)[] = [];
    const root = createScope({
      tags: [smtpUrl(new URL(url))],
      presets: [
        preset(
          smtpNet,
          async () =>
            ({
              createConnection: (config: unknown) => {
                expect(config).toEqual({ host, port });
                const socket = Object.assign(new EventEmitter(), {
                  destroy: (error?: Error) => {
                    destroyed.push(error);
                  },
                });
                sockets.push(socket);
                return socket;
              },
            }) as unknown as typeof import("node:net"),
        ),
      ],
    });
    try {
      const owner = await root.resolve(smtpSockets);
      const owned = owner.open();
      const callbacks: unknown[][] = [];
      const callback: GetSocketCallback = (...args) => {
        callbacks.push(args);
      };
      owner.getSocket(owned, {}, callback);
      expect(sockets[0]!.listenerCount("connect")).toBe(1);
      expect(sockets[0]!.listenerCount("close")).toBe(1);
      expect(sockets[0]!.listenerCount("error")).toBe(2);
      sockets[0]!.emit("connect");
      expect(callbacks).toEqual([[null, { connection: sockets[0] }]]);
      expect(sockets[0]!.listenerCount("connect")).toBe(0);
      expect(sockets[0]!.listeners("error")).not.toContain(callback);
      sockets[0]!.emit("error", new Error("late transport error"));
      expect(callbacks).toHaveLength(1);
      sockets[0]!.emit("close");
      owner.close(owned, new Error("Mail send total timeout"));
      expect(destroyed).toEqual([]);

      owner.getSocket(owned, {}, callback);
      const refused = new Error("TCP refused");
      sockets[1]!.emit("error", refused);
      expect(callbacks[1]).toEqual([refused]);
      sockets[1]!.emit("error", new Error("second error"));
      expect(callbacks).toHaveLength(2);
      owner.close(owned, new Error("Mail send total timeout"));
      expect(destroyed).toHaveLength(1);
      expect(destroyed[0]?.message).toBe("Mail send total timeout");
      owner.getSocket(owned, {}, callback);
      await root.close({ graceful: true });
      expect(destroyed).toHaveLength(2);
      expect(destroyed[1]).toBeUndefined();
    } finally {
      await root.close();
    }
  });
}

for (const stopped of ["abort", "deadline"] as const) {
  test(`SMTP ${stopped} destroys sockets, replaces the transport, and removes its timer`, async () => {
    const clock = makeTestClock();
    const timers: AbortSignal[] = [];
    const stop = new AbortController();
    const reason = new Error("cancel send");
    const sent: number[] = [];
    const closed: number[] = [];
    let transports = 0;
    let aborted = 0;
    const root = createScope({
      clock: {
        ...clock,
        sleep: (ms, signal) => {
          if (signal) timers.push(signal);
          return clock.sleep(ms, signal);
        },
      },
      tags: [
        smtpUrl(new URL("smtp://relay.test")),
        mailFrom("sender@example.test"),
        mailSendTimeout(100),
      ],
      presets: [
        preset(smtpSockets, async () => ({
          open: () => new Set<Socket>(),
          getSocket: (_owned: Set<Socket>, _options: unknown, _callback: GetSocketCallback) => {},
          close: (_owned: Set<Socket>, error?: Error) => {
            if (error) aborted++;
          },
        })),
        preset(
          smtp,
          async () =>
            ({
              default: {
                createTransport: () => {
                  const id = ++transports;
                  return {
                    sendMail: () => {
                      sent.push(id);
                      return id === 1 ? new Promise(() => {}) : Promise.resolve();
                    },
                    close: () => {
                      closed.push(id);
                    },
                  };
                },
              },
            }) as unknown as typeof import("nodemailer"),
        ),
      ],
    });

    try {
      const sender = await root.resolve(mail);
      const message = { to: "receiver@example.test", subject: "Send", text: "Body" };
      const first = sender.send(message, { signal: stop.signal });
      const failure = first.catch((error) => error);

      expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.aborted).toBe(false);
      if (stopped === "abort") stop.abort(reason);
      else clock.advance(100);
      const result = await failure;
      if (stopped === "abort") expect(result).toBe(reason);
      else expect(result).toMatchObject({ message: "Mail send total timeout" });
      expect(aborted).toBe(1);
      expect(closed).toEqual([1]);
      expect(transports).toBe(1);
      expect(getEventListeners(stop.signal, "abort")).toEqual([]);
      expect(timers.every((timer) => timer.aborted)).toBe(true);
      await sender.send(message);
      expect(sent).toEqual([1, 2]);
      expect(timers.every((timer) => timer.aborted)).toBe(true);
      clock.advance(1000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(aborted).toBe(1);
      expect(transports).toBe(2);
      await root.close({ graceful: true });
      expect(closed).toEqual([1, 2]);
    } finally {
      await root.close();
    }
  });
}

test("one SMTP deadline leaves the other send alive and reuses its healthy transport", async () => {
  const clock = makeTestClock();
  const pending: { transport: number; finish: ReturnType<typeof Promise.withResolvers<void>> }[] =
    [];
  let created = 0;
  const root = createScope({
    clock,
    tags: [
      smtpUrl(new URL("smtp://relay.test")),
      mailFrom("sender@example.test"),
      mailSendTimeout(100),
    ],
    presets: [
      preset(smtpSockets, async () => ({
        open: () => new Set<Socket>(),
        getSocket: (_owned: Set<Socket>, _options: unknown, _callback: GetSocketCallback) => {},
        close() {},
        abort() {},
      })),
      preset(
        smtp,
        async () =>
          ({
            default: {
              createTransport: () => {
                const transport = ++created;
                return {
                  sendMail: () => {
                    const finish = Promise.withResolvers<void>();
                    pending.push({ transport, finish });
                    return finish.promise;
                  },
                  close: () => {
                    for (const call of pending.filter((call) => call.transport === transport)) {
                      call.finish.reject(new Error("transport closed"));
                    }
                  },
                };
              },
            },
          }) as unknown as typeof import("nodemailer"),
      ),
    ],
  });

  try {
    const sender = await root.resolve(mail);
    const message = { to: "receiver@example.test", subject: "Send", text: "Body" };
    const first = sender.send(message).catch((error) => error);
    clock.advance(50);
    const second = sender.send(message).then(
      () => "sent",
      (error) => error,
    );

    clock.advance(50);
    expect(await first).toBeInstanceOf(Error);
    pending[1]!.finish.resolve();
    expect(await second, "send timeout must leave other sends running").toBe("sent");

    const third = sender.send(message);
    pending[2]!.finish.resolve();
    await third;
    expect(created, "successful sends reuse their healthy transport").toBe(2);
    expect(pending.map((call) => call.transport)).toEqual([1, 2, 2]);
  } finally {
    await root.close();
  }
});
