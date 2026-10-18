import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDispatch } from "./proof-write.mjs";

const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { databaseUrl, databaseSetup } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const { mail, smtpUrl, mailFrom, deliverMailBatch } = await vite.ssrLoadModule(
  "/tinker/components/mail/index.server.ts",
);

const { authSettings, authStartup, handleAuth } = await vite.ssrLoadModule(
  "/tinker/components/auth/index.server.ts",
);

const { startRequests, backendStop } = await vite.ssrLoadModule(
  "/tinker/components/requests/index.server.ts",
);

if (process.argv.includes("--server")) {
  const root = createScope({
    extensions: [startRequests, authStartup, databaseSetup],
    tags: [
      databaseUrl(new URL(process.env.PROOF_AUTH_DATABASE)),
      backendStop(new AbortController().signal),
      authSettings({
        origin: "http://localhost:4318",
        secret: "proof-secret-with-at-least-thirty-two-letters",
      }),
    ],
    presets: [preset(mail, async () => ({ send: async () => new Promise(() => {}) }))],
  });

  await root.ready;

  const response = await root.run(handleAuth, {
    input: new Request("http://localhost:4318/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:4318" },
      body: JSON.stringify({
        name: "Durable",
        email: process.env.PROOF_AUTH_EMAIL,
        password: "safe-password-42",
      }),
    }),
    signal: new AbortController().signal,
  });

  assert.equal(response.status, 200, await response.text());

  process.stdout.write("AUTH_ENQUEUE_RETURNED\n");

  // Parent intentionally terminates this server by PID after enqueue, before SMTP.
  setInterval(() => {}, 1000);
} else {
  const admin = new pg.Client({
    connectionString:
      process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres",
  });

  const name = "auth_mail_" + randomUUID().replaceAll("-", "");

  const email = name + "@example.test";

  let child;

  let worker;

  let observer;

  let closed;

  try {
    await admin.connect();

    await admin.query(`CREATE DATABASE ${name}`);

    const url = new URL(
      process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres",
    );
    url.pathname = "/" + name;

    child = spawn(process.execPath, ["maintain/proof-auth-mail.mjs", "--server"], {
      env: { ...process.env, PROOF_AUTH_DATABASE: url.href, PROOF_AUTH_EMAIL: email },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errors = "";

    closed = new Promise((resolve) => child.once("exit", resolve));

    child.stderr.on("data", (data) => {
      errors += data;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("auth server did not finish enqueue: " + errors)),
        10000,
      );
      child.stdout.on("data", (data) => {
        output += data;
        if (output.includes("AUTH_ENQUEUE_RETURNED")) {
          clearTimeout(timer);
          resolve();
        }
      });

      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(output + errors));
      });
    });

    child.kill("SIGKILL");

    await closed;

    observer = new pg.Client({ connectionString: url.href });
    await observer.connect();

    assert.equal(
      (
        await observer.query('SELECT count(*)::int AS count FROM mail_outbox WHERE "to"=$1', [
          email,
        ])
      ).rows[0].count,
      1,
      "auth enqueue must survive server death before SMTP",
    );

    worker = createScope({
      tags: [
        databaseUrl(url),
        smtpUrl(new URL("smtp://127.0.0.1:11026")),
        mailFrom("proof@example.test"),
      ],
    });

    await worker.ready;

    assert.deepEqual(await writeDispatch().run(worker, deliverMailBatch), {
      claimed: 1,
      sent: 1,
      failed: 0,
    });

    assert.equal(
      (
        await observer.query(
          'SELECT attempts,sent_at IS NOT NULL AS sent FROM mail_outbox WHERE "to"=$1',
          [email],
        )
      ).rows[0].sent,
      true,
    );

    const inbox = await (
      await fetch(`http://127.0.0.1:18026/api/v1/search?query=${encodeURIComponent("to:" + email)}`)
    ).json();

    assert.equal(
      inbox.messages.length,
      1,
      "restarted worker must deliver durable auth mail to local Mailpit",
    );

    console.log(
      "PASS durable auth mail: actual sign-up callback returns, server PID is killed before SMTP, new worker delivers saved mail to local Mailpit.",
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
    await worker?.close();
    await observer?.end();

    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await vite.close();
  }
}
