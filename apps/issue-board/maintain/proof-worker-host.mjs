import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

const directory = await mkdtemp(
  fileURLToPath(new URL("../.bench/worker-no-env-", import.meta.url)),
);

const db = new pg.Client({ connectionString: "postgres://issue_board@127.0.0.1:15433/postgres" });
await db.connect();
await db.query("BEGIN");
await db.query("SELECT id FROM mail_outbox WHERE sent_at IS NULL FOR UPDATE");
assert.equal(existsSync(`${directory}/.env`), false);
const day = new Date().toISOString().slice(0, 10);

const before = (
  await db.query("SELECT id,dedupe_key FROM mail_outbox WHERE dedupe_key LIKE $1 ORDER BY id", [
    `digest:%:${day}`,
  ])
).rows;

assert(before.length > 0, "The demo must first create a daily receipt");

const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.mjs", import.meta.url))], {
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

const exited = once(child, "exit");

try {
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
  assert.equal(code, 0, errors);
  assert(output.includes("outbox worker stopped\n"));
  const after = (
    await db.query("SELECT id,dedupe_key FROM mail_outbox WHERE dedupe_key LIKE $1 ORDER BY id", [
      `digest:%:${day}`,
    ])
  ).rows;
  assert.deepEqual(after, before);
  assert(output.includes('"message":"digest.queued"'));
  console.log(
    "PASS digest process restart: fresh built worker ticks with hour=0 and leaves today's durable receipts unchanged.",
  );
  console.log(
    "PASS worker host: no .env file; explicit local settings start the built worker; SIGTERM prints stopped and exits 0.",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  await db.query("ROLLBACK");
  await db.end();
  await rm(directory, { recursive: true });
}
