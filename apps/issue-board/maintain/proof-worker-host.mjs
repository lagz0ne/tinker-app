import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

const directory = await mkdtemp(
  fileURLToPath(new URL("../.bench/worker-no-env-", import.meta.url)),
);

const db = new pg.Client({ connectionString: "postgres://issue_board@127.0.0.1:15433/postgres" });
const account = "worker-host-" + randomUUID();
const team = randomUUID();
const issue = randomUUID();
const day = new Date().toISOString().slice(0, 10);
const receipt = `digest:${account}:${day}`;
let child;
let exited;

try {
  await db.connect();
  await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [
    account,
    `${account}@example.test`,
  ]);
  await db.query("INSERT INTO team(id,key,name) VALUES($1,$2,'Worker host proof')", [
    team,
    account,
  ]);
  await db.query("INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'admin')", [
    team,
    account,
  ]);
  await db.query(
    "INSERT INTO issue(id,team_id,number,title,creator_id,rank) VALUES($1,$2,1,'Restart proof',$3,'a0')",
    [issue, team, account],
  );
  await db.query(
    'INSERT INTO mail_outbox("to",subject,text,dedupe_key,sent_at,attempts) VALUES($1,$2,$2,$3,now(),1)',
    [`${account}@example.test`, `Daily issue digest ${day}`, receipt],
  );
  await db.query("BEGIN");
  await db.query("SELECT id FROM mail_outbox WHERE sent_at IS NULL FOR UPDATE");
  assert.equal(existsSync(`${directory}/.env`), false);
  const before = (
    await db.query("SELECT id,dedupe_key,attempts,sent_at FROM mail_outbox WHERE dedupe_key=$1", [
      receipt,
    ])
  ).rows;
  assert.equal(before.length, 1, "The proof owns a durable daily receipt for an eligible account");

  // Startup owns migrations too; the deployment folder carries the actual chain.
  await cp(new URL("../drizzle", import.meta.url), `${directory}/drizzle`, { recursive: true });

  child = spawn(process.execPath, [fileURLToPath(new URL("./worker.mjs", import.meta.url))], {
    cwd: directory,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://issue_board@127.0.0.1:15433/postgres",
      SMTP_URL: "smtp://127.0.0.1:11026",
      SMTP_FROM: "board@example.test",
      DIGEST_HOUR_UTC: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let errors = "";
  const ready = Promise.withResolvers();

  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.includes('"message":"outbox.batch"')) ready.resolve();
  });

  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });

  exited = once(child, "exit");
  await Promise.race([
    ready.promise,
    exited.then(() => {
      throw new Error(`Worker exited early: ${errors}`);
    }),
    once(AbortSignal.timeout(15_000), "abort").then(() => {
      throw new Error(`Worker did not start: ${errors}`);
    }),
  ]);

  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 143, errors);
  assert(output.includes("outbox worker stopped\n"));
  const after = (
    await db.query("SELECT id,dedupe_key,attempts,sent_at FROM mail_outbox WHERE dedupe_key=$1", [
      receipt,
    ])
  ).rows;
  assert.deepEqual(after, before);
  assert(output.includes('"message":"digest.completed"'));
  console.log(
    "PASS digest process restart: fresh built worker ticks with hour=0 and leaves today's durable receipts unchanged.",
  );
  console.log(
    "PASS worker host: no .env file; explicit local settings start the built worker; SIGTERM prints stopped and exits 143.",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }

  await db.query("ROLLBACK");
  await db.query("DELETE FROM mail_outbox WHERE dedupe_key=$1", [receipt]);
  await db.query("DELETE FROM issue WHERE id=$1", [issue]);
  await db.query("DELETE FROM team_member WHERE team_id=$1", [team]);
  await db.query("DELETE FROM team WHERE id=$1", [team]);
  await db.query('DELETE FROM "user" WHERE id=$1', [account]);

  await db.end();
  await rm(directory, { recursive: true });
}
