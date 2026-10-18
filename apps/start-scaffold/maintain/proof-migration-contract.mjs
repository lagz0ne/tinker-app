import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import pg from "pg";
import { createServer } from "vite-plus";

const app = fileURLToPath(new URL("..", import.meta.url));

const original = process.cwd();

const migrations = resolve(process.env.BOARD_PROOF_MIGRATION_ROOT ?? app);

const vite = await createServer({
  root: app,
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "~": fileURLToPath(new URL("../tinker", import.meta.url)) } },
});

const { databaseUrl, databaseSetup } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const admin = new pg.Client({ connectionString });

const name = "migration_contract_" + randomUUID().replaceAll("-", "");

const url = new URL(connectionString);
url.pathname = "/" + name;

const publisher = new pg.Client({ connectionString: url.href });

const listener = new pg.Client({ connectionString: url.href });

let root;

let count = 0;

let fenced = Promise.withResolvers();

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);

  process.chdir(migrations);

  root = createScope({ extensions: [databaseSetup], tags: [databaseUrl(url)] });

  await root.ready;

  await publisher.connect();
  await listener.connect();

  const triggers = await publisher.query(
    "SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='mail_outbox'::regclass AND tgname='board_outbox_insert' AND tgenabled='O'",
  );

  assert.equal(
    triggers.rowCount,
    1,
    "mail migration must install its enabled notification trigger",
  );

  assert.match(
    triggers.rows[0].definition,
    /AFTER INSERT[\s\S]*REFERENCING NEW TABLE AS added[\s\S]*FOR EACH STATEMENT/,
    "mail trigger must use statement transition rows",
  );

  const fn = (
    await publisher.query(
      "SELECT pg_get_functiondef('notify_board_outbox()'::regprocedure) AS definition",
    )
  ).rows[0].definition;

  assert.match(
    fn,
    /pg_notify\('board_outbox'/,
    "mail notification function must publish board_outbox",
  );

  assert.match(
    fn,
    /IF EXISTS\s*\(SELECT 1 FROM added\)/,
    "mail function must suppress empty statement notifications",
  );

  listener.on("notification", (event) => {
    if (event.channel === "board_outbox") count++;
    else fenced.resolve();
  });

  await listener.query("LISTEN board_outbox; LISTEN migration_proof_fence");

  await publisher.query(
    "INSERT INTO mail_outbox(\"to\",subject,text,dedupe_key) SELECT 'proof@example.test','Empty','None','empty' WHERE false",
  );

  await publisher.query("SELECT pg_notify('migration_proof_fence','empty')");
  await fenced.promise;

  assert.equal(count, 0, "empty insert must not publish a mail wake");

  fenced = Promise.withResolvers();

  await publisher.query("BEGIN");

  await publisher.query(
    "INSERT INTO mail_outbox(\"to\",subject,text,dedupe_key) VALUES('proof@example.test','Rollback','None','rollback')",
  );

  await publisher.query("ROLLBACK");

  await publisher.query("SELECT pg_notify('migration_proof_fence','rollback')");
  await fenced.promise;

  assert.equal(count, 0, "rolled-back insert must not publish a mail wake");

  fenced = Promise.withResolvers();

  await publisher.query("BEGIN");

  await publisher.query(
    "INSERT INTO mail_outbox(\"to\",subject,text,dedupe_key) SELECT 'proof@example.test','Batch','None',n::text FROM generate_series(1,21) n",
  );

  assert.equal(count, 0, "mail wake must wait for COMMIT");

  await publisher.query("COMMIT");

  await publisher.query("SELECT pg_notify('migration_proof_fence','commit')");
  await fenced.promise;

  assert.equal(count, 1, "committed multi-row statement must publish one mail wake");

  console.log(
    "PASS real migration contract: enabled transition-table trigger; empty and rollback silent; committed batch wakes once, ordered by a second-channel fence.",
  );
} finally {
  process.chdir(original);

  await listener.end().catch(() => {});
  await publisher.end().catch(() => {});
  await root?.close();

  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  await vite.close();
}
