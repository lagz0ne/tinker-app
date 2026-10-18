import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { createMainHost } from "../../../packages/start/lib/main-host.mjs";
import { proofFault } from "./proof-fault.mjs";
import { writeDatabase } from "./proof-write.mjs";

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  plugins: [proofFault()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { database, leaseFrom } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const { smtpUrl, mailFrom } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");
const { smtp } = await vite.ssrLoadModule("/tinker/components/mail/modules.ts");
const { tickMailDigest } = await vite.ssrLoadModule("/src/backend/digest.server.ts");
const { runMailPass } = await vite.ssrLoadModule("/src/backend/outbox.server.ts");
const { mailWorkerStop } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");
const schema = "alert_grace_" + randomUUID().replaceAll("-", "");
const key = Math.floor(Math.random() * 1000000000);

const client = new pg.Client({
  connectionString: "postgres://issue_board@127.0.0.1:15433/postgres",
});

const peer = new pg.Client({ connectionString: "postgres://issue_board@127.0.0.1:15433/postgres" });
const entered = Promise.withResolvers();
const hard = Promise.withResolvers();
let rejectSend;
let root;
let host;
let commits = 0;

const checked = new Proxy(client, {
  get(target, key) {
    if (key !== "query") return Reflect.get(target, key, target);
    return (...args) => {
      if (args[0] === "COMMIT") commits += 1;
      return target.query(...args);
    };
  },
});

try {
  await client.connect();

  await peer.connect();

  await peer.query(
    `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.mail_outbox (LIKE public.mail_outbox INCLUDING ALL); INSERT INTO ${schema}.mail_outbox(id,"to",subject,text,dedupe_key,next_at) VALUES(1,'proof@example.test','Grace proof','Never sent','proof',now())`,
  );

  await client.query(`SET search_path TO ${schema},public`);

  await peer.query(
    `CREATE FUNCTION ${schema}.hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER hold_commit AFTER UPDATE ON ${schema}.mail_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.lease_token IS NULL) EXECUTE FUNCTION ${schema}.hold_commit()`,
  );

  await peer.query("SELECT pg_advisory_lock($1)", [key]);

  host = createMainHost(
    async ({ signal }) => {
      root = createScope({
        tags: [
          mailWorkerStop(signal),
          smtpUrl(new URL("smtp://127.0.0.1:11026")),
          mailFrom("proof@example.test"),
        ],
        presets: [
          preset(database, async () => writeDatabase(checked, leaseFrom)),
          preset(tickMailDigest, async () => {}),
          preset(smtp, async () => ({
            default: {
              createTransport: () => ({
                sendMail() {
                  entered.resolve();
                  return new Promise((_resolve, reject) => {
                    rejectSend = reject;
                  });
                },
                close() {
                  rejectSend?.(new Error("slow sender closed"));
                },
              }),
            },
          })),
        ],
      });
      await root.ready;
      return { closed: root.run(runMailPass).finally(() => root.close({ graceful: true })) };
    },
    {
      env: {},
      stdout: { write() {} },
      stderr: { write() {} },
      hardStop: () => hard.resolve("hard-stop"),
    },
  );

  await host.started;

  await entered.promise;
  host.stop(143);

  const result = await Promise.race([host.closed, hard.promise]);

  assert.notEqual(
    result,
    "hard-stop",
    "alert send plus record and held COMMIT must end before host hard stop",
  );

  assert.equal(result, 143);

  assert.equal(commits, 2, "proof must reach the held COMMIT after recording the send failure");

  const row = (await peer.query(`SELECT attempts,sent_at FROM ${schema}.mail_outbox`)).rows[0];

  assert.equal(
    row.attempts,
    1,
    "held acknowledgement COMMIT rolls back but retains committed claim",
  );

  assert.equal(row.sent_at, null);

  console.log(
    "PASS real worker pass: total send deadline, record, held COMMIT and rollback finish before the host's 10 s hard stop.",
  );
} finally {
  rejectSend?.(new Error("proof cleanup"));

  await peer.query("SELECT pg_advisory_unlock_all()").catch(() => {});

  await host?.closed;

  await root?.close({ graceful: true });

  await peer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

  await client.end().catch(() => {});

  await peer.end();

  await vite.close();
}
