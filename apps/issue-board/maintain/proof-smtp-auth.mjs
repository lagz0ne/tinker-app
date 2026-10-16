import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { createServer } from "vite-plus";

const vite = await createServer({
  configFile: false,
  cacheDir: ".tinker/proof-smtp-auth-vite-cache",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { alertMail } = await vite.ssrLoadModule("/src/backend/alert-mail.server.ts");
const { smtpUrl, mailFrom } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");
const subject = `SMTP auth proof ${randomUUID()}`;

// This second Mailpit requires the synthetic credentials; all endpoints are local.
for (const credential of ["", "digest%2Duser:wrong@", "digest%2Duser:p%40ss-word@"]) {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags: [smtpUrl(new URL(`smtp://${credential}127.0.0.1:11027`)), mailFrom("board@example.test")],
  });
  await root.ready;
  try {
    const mail = await root.resolve(alertMail);
    if (credential === "digest%2Duser:p%40ss-word@") {
      await mail.send({
        to: "proof@example.test",
        subject,
        text: "Local Mailpit authentication proof",
      });
    } else {
      await assert.rejects(
        mail.send({ to: "proof@example.test", subject, text: "Must not arrive" }),
      );
    }
  } finally {
    stop.abort();
    await root.closed;
  }
}

const inbox = await (
  await fetch(
    `http://127.0.0.1:18027/api/v1/search?query=${encodeURIComponent(`subject:${subject}`)}`,
  )
).json();

assert.equal(inbox.messages.length, 1);

console.log(
  "PASS SMTP auth: local Mailpit refuses missing/wrong login; decoded SMTP URL user/password delivers exactly one message.",
);

await vite.close();
