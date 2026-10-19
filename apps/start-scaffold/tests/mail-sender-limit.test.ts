import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import {
  mail,
  mailFrom,
  mailMaxSenders,
  mailSendTimeout,
  smtpUrl,
} from "~/components/mail/index.server";
import { smtp } from "~/components/mail/modules";

for (const limit of [1, 4]) {
  test(`SMTP caps open senders at ${limit}, cancels queued sends, and starts deadlines after waiting`, async () => {
    const clock = makeTestClock();

    const pending: ReturnType<typeof Promise.withResolvers<void>>[] = [];

    let open = 0;

    let peak = 0;

    const root = createScope({
      clock,
      tags: [
        smtpUrl(new URL("smtp://relay.test")),
        mailFrom("sender@example.test"),
        mailMaxSenders(limit),
        mailSendTimeout(100),
      ],
      presets: [
        preset(
          smtp,
          async () =>
            ({
              default: {
                createTransport: () => {
                  open++;

                  peak = Math.max(peak, open);

                  return {
                    close: () => {
                      open--;
                    },
                    sendMail: () => {
                      const sent = Promise.withResolvers<void>();

                      pending.push(sent);

                      return sent.promise;
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

      const message = { to: "receiver@example.test", subject: "Bounded", text: "Body" };

      const active = Array.from({ length: limit }, () => sender.send(message));

      const stop = new AbortController();

      const reason = new Error("cancel queued send");

      const cancelled = sender.send(message, { signal: stop.signal }).catch((error) => error);

      let completed = false;

      const queued = sender.send(message).then(() => {
        completed = true;
      });

      expect(pending).toHaveLength(limit);

      expect(open).toBe(limit);

      stop.abort(reason);

      expect(await cancelled).toBe(reason);

      expect(pending).toHaveLength(limit);

      // The queued send crosses its arrival deadline while its own send stays in time.
      clock.advance(60);

      pending[0]!.resolve();

      await active[0];

      await Promise.resolve();

      expect(pending).toHaveLength(limit + 1);

      for (const sent of pending.slice(1, limit)) sent.resolve();

      await Promise.all(active);

      clock.advance(50);

      expect(completed).toBe(false);

      pending[limit]!.resolve();

      await Promise.all([queued, ...active]);

      expect(completed).toBe(true);

      expect(peak).toBe(limit);

      expect(open).toBe(limit);
    } finally {
      await root.close();
    }
    expect(open).toBe(0);
  });
}

test("a sender queue may wait longer than the total send timeout", async () => {
  const clock = makeTestClock();

  const pending: ReturnType<typeof Promise.withResolvers<void>>[] = [];

  let created = 0;

  const root = createScope({
    clock,
    tags: [
      smtpUrl(new URL("smtp://relay.test")),
      mailFrom("sender@example.test"),
      mailMaxSenders(1),
      mailSendTimeout(100),
    ],
    presets: [
      preset(
        smtp,
        async () =>
          ({
            default: {
              createTransport: () => {
                created++;

                return {
                  close: () => {},
                  sendMail: () => {
                    const sent = Promise.withResolvers<void>();

                    pending.push(sent);

                    return sent.promise;
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

    const message = { to: "receiver@example.test", subject: "Queued", text: "Body" };

    const sends = Array.from({ length: 3 }, () => sender.send(message));

    for (let index = 0; index < sends.length; index++) {
      expect(pending).toHaveLength(index + 1);

      clock.advance(60);

      pending[index]!.resolve();

      await sends[index];

      await Promise.resolve();
    }
    await Promise.all(sends);

    expect(created).toBe(1);
  } finally {
    await root.close();
  }
});
