import { createScope, type Observe } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { mail, mailFrom, smtpUrl, sendMail } from "~/components/mail/index.server";
import { smtp } from "~/components/mail/modules";

for (const [url, expected] of [
  ["smtp://[::1]:2525", { host: "::1", port: 2525, secure: false, auth: undefined }],
  ["smtps://mail.test", { host: "mail.test", port: undefined, secure: true, auth: undefined }],
  [
    "smtp://u%40ser:p%3Ass@mail.test:465",
    { host: "mail.test", port: 465, secure: true, auth: { user: "u@ser", pass: "p:ss" } },
  ],
  ["smtp://mail.test", { host: "mail.test", port: undefined, secure: false, auth: undefined }],
] as const) {
  test(`SMTP ${url} sets its connection, sends the whole message, then closes`, async () => {
    const options: unknown[] = [];
    const sent: unknown[] = [];
    let closed = 0;
    const root = createScope({
      tags: [smtpUrl(new URL(url)), mailFrom("sender@example.com")],
      presets: [
        preset(
          smtp,
          async () =>
            ({
              default: {
                createTransport: (config: unknown) => {
                  options.push(config);
                  return {
                    close: () => {
                      closed++;
                    },
                    sendMail: async (message: unknown) => {
                      sent.push(message);
                    },
                  };
                },
              },
            }) as unknown as typeof import("nodemailer"),
        ),
      ],
    });

    await root.ready;
    const sender = await root.resolve(mail);
    const message = { to: "receiver@example.com", subject: "Subject", text: "Body 😀" };
    await sender.send(message);
    expect(options).toMatchObject([
      {
        ...expected,
        pool: true,
        maxConnections: 1,
        dnsTimeout: 3000,
        connectionTimeout: 3000,
        greetingTimeout: 3000,
        socketTimeout: 3000,
      },
    ]);
    expect(sent).toEqual([{ ...message, from: "sender@example.com" }]);
    expect(closed).toBe(0);
    expect((await root.close({ graceful: true })).status).toBe("success");
    expect(closed).toBe(1);
  });
}

test("a send failure reaches the caller and never logs completion", async () => {
  const error = new Error("SMTP refused");
  const logs: Observe.Log[] = [];
  const root = createScope({
    observe: { history: 20, log: (entry) => logs.push(entry) },
    presets: [
      preset(mail, async () => ({
        send: async () => {
          throw error;
        },
      })),
    ],
  });

  await root.ready;
  const result = await root.settle(sendMail, {
    input: { to: "a@example.com", subject: "x", text: "y" },
  });
  expect(result).toMatchObject({ status: "failed", error });
  expect(logs.filter((entry) => entry.message === "mail.completed")).toEqual([]);
  await root.close({ graceful: true });
});

test("public sender abort closes transport and rejects with the caller reason", async () => {
  let starts = 0;
  let closes = 0;
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  const stop = new AbortController();
  const reason = new Error("caller cancelled mail");
  const root = createScope({
    tags: [smtpUrl(new URL("smtp://127.0.0.1:11026")), mailFrom("proof@example.test")],
    presets: [
      preset(
        smtp,
        async () =>
          ({
            default: {
              createTransport: () => ({
                sendMail() {
                  starts++;
                  entered.resolve();
                  return pending.promise;
                },
                close() {
                  closes++;
                  pending.reject(reason);
                },
              }),
            },
          }) as unknown as typeof import("nodemailer"),
      ),
    ],
  });

  await root.ready;
  const sender = await root.resolve(mail);
  const message = { to: "proof@example.test", subject: "Abort", text: "No SMTP" };
  const sent = sender.send(message, { signal: stop.signal });
  const refused = expect(sent).rejects.toBe(reason);
  await entered.promise;
  stop.abort(reason);
  await refused;
  expect(closes).toBe(1);
  expect(starts).toBe(1);
  await expect(sender.send(message, { signal: stop.signal })).rejects.toBe(reason);
  expect(starts).toBe(1);
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(closes).toBe(2);
});
