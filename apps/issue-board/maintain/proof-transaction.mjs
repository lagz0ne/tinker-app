import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const directory = resolve(process.env.BOARD_PROOF_SERVER ?? ".");
const origin = "http://127.0.0.1:4331";
const prefix = "commit-proof-" + randomUUID();
const email = prefix + "@example.test";
const peer = prefix + "-peer";
const teamId = randomUUID();
const issueId = randomUUID();
const ids = [randomUUID(), randomUUID()];
const functionName = "proof_commit_" + randomUUID().replaceAll("-", "");
const lockKey = Math.floor(Math.random() * 1_000_000_000);
const connectionString = "postgres://issue_board@127.0.0.1:15433/postgres";
const workerUrl = new URL(connectionString);
workerUrl.searchParams.set("application_name", prefix);

const env = {
  ...process.env,
  PORT: "4331",
  HOST: "127.0.0.1",
  PUBLIC_ORIGIN: origin,
  AUTH_SECRET: "local-commit-proof-secret-with-thirty-two-letters",
  DATABASE_URL: workerUrl.href,
  SMTP_URL: "smtp://127.0.0.1:11026",
  SMTP_FROM: "board@example.test",
  OTEL_SERVICE_NAME: "issue-board",
  VICTORIA_TRACES_URL: "http://127.0.0.1:11428/insert/opentelemetry/v1/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:19428/insert/opentelemetry/v1/logs",
};

const db = new pg.Client({ connectionString });
const gate = new pg.Client({ connectionString });
await db.connect();
await gate.connect();

const server = spawn(
  process.execPath,
  [resolve("node_modules/@tinker/start/bin/tinker.mjs"), "serve"],
  { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
);

let logs = "";

server.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});

server.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

const exited = new Promise((done) => server.once("exit", (code, signal) => done({ code, signal })));
let actor;
let trigger = false;
let failure;
const pendingReplies = [];
const csv = resolve(".tinker/" + prefix + ".csv");

try {
  const deadline = AbortSignal.timeout(30_000);
  while (true) {
    deadline.throwIfAborted();
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise((done) => setTimeout(done, 25));
  }
  const signup = await fetch(origin + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Commit actor", email, password: "proof-password-42" }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  actor = (await db.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0].id;
  await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$2)', [
    peer,
    peer + "@example.test",
  ]);
  await db.query("INSERT INTO team(id,key,name,issue_seq) VALUES($1,$2,'Commit proof',1)", [
    teamId,
    prefix,
  ]);
  await db.query(
    "INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')",
    [teamId, actor, peer],
  );
  await db.query(
    "INSERT INTO issue(id,team_id,number,title,creator_id,rank) VALUES($1,$2,1,'Before commit',$3,'a0')",
    [issueId, teamId, actor],
  );
  await db.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id IN ('${ids[0]}','${ids[1]}') THEN
      PERFORM pg_advisory_xact_lock(${lockKey});
      IF NEW.id = '${ids[1]}' THEN RAISE EXCEPTION 'proof failed COMMIT' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END $$`);
  await db.query(`CREATE CONSTRAINT TRIGGER ${functionName} AFTER INSERT ON sync_execution
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  trigger = true;
  const output = resolve(directory, "dist/server");
  const built = readdirSync(output, { recursive: true })
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(resolve(output, file), "utf8"))
    .join("\n");
  const functionId =
    /"([a-f0-9]{64})": \{\s+functionName: "updateIssue_createServerFn_handler"/.exec(built)?.[1];
  assert(functionId);
  const require = createRequire(import.meta.url);
  const startRequire = createRequire(require.resolve("@tanstack/react-start/package.json"));
  const clientRequire = createRequire(
    startRequire.resolve("@tanstack/start-client-core/package.json"),
  );
  const { toJSONAsync } = await import(pathToFileURL(clientRequire.resolve("seroval")));

  for (const [index, executionId] of ids.entries()) {
    const saved = (await db.query("SELECT * FROM issue WHERE id=$1", [issueId])).rows[0];
    const body = JSON.stringify(
      await toJSONAsync({
        data: {
          executionId,
          change: {
            kind: "move",
            teamId,
            id: issueId,
            version: saved.version,
            state: index ? "backlog" : "in_progress",
            beforeId: null,
          },
        },
      }),
    );
    await gate.query("SELECT pg_advisory_lock($1)", [lockKey]);
    let bytes = 0;

    const reply = new Promise((done, reject) => {
      const req = request(
        origin + "/_serverFn/" + functionId,
        {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-tsr-serverFn": "true",
            accept: "application/json",
          },
          signal: AbortSignal.timeout(30_000),
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => done({ status: response.statusCode, text }));
        },
      );
      req.on("socket", (socket) =>
        socket.on("data", (chunk) => {
          bytes += chunk.length;
        }),
      );
      req.on("error", reject);
      req.end(body);
    });
    pendingReplies.push(reply);
    const waiting = AbortSignal.timeout(20_000);
    while (true) {
      waiting.throwIfAborted();
      const blocked = await db.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query='COMMIT' AND wait_event='advisory'",
        [prefix],
      );
      if (blocked.rowCount === 1) break;
      await new Promise((done) => setImmediate(done));
    }
    // Let the HTTP socket run while the database is still holding COMMIT.
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(bytes, 0, "no HTTP response byte may precede COMMIT");
    await gate.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    const response = await reply;
    if (index === 0) {
      assert.equal(response.status, 200, response.text);
      assert(response.text.includes("accepted"), response.text);
      assert.equal(
        (await db.query("SELECT version FROM issue WHERE id=$1", [issueId])).rows[0].version,
        2,
      );
      console.log(
        "PASS real server-function: COMMIT held on a deferred trigger; zero response bytes before release; accepted only after COMMIT completes.",
      );
    } else {
      assert.equal(response.status, 200, "server-function errors use the RPC envelope");
      assert(
        response.text.includes("TeardownFailed"),
        "failed COMMIT must be a client RPC error: " + response.text,
      );
      assert(!response.text.includes("accepted"), response.text);

      assert.equal(
        (await db.query("SELECT version,state FROM issue WHERE id=$1", [issueId])).rows[0].version,
        2,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM sync_execution WHERE id=$1", [executionId]))
          .rows[0].n,
        0,
      );
      assert.equal(
        (
          await db.query("SELECT count(*)::int AS n FROM mail_outbox WHERE dedupe_key LIKE $1", [
            executionId + ":%",
          ])
        ).rows[0].n,
        0,
      );
      console.log(
        "PASS real server-function: deferred COMMIT fails 23514; client RPC error, never accepted; issue/version, execution, events and outbox roll back.",
      );
    }
  }

  const lines = Array.from({ length: 201 }, (_, index) => `CSV-${index},Row ${index},`);

  lines[150] = "CSV-150,Row 150,missing@example.test";

  writeFileSync(csv, "ID,Title,Assignee\r\n" + lines.join("\r\n"));
  const args = [resolve("maintain/cli.mjs"), "--file", csv, "--team", prefix, "--actor", email];
  const bad = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(bad.status, 65, bad.stderr);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM issue WHERE team_id=$1 AND external_id IS NOT NULL",
        [teamId],
      )
    ).rows[0].n,
    100,
    "failed second batch must roll back every row in that batch",
  );
  assert.equal(
    (await db.query("SELECT issue_seq FROM team WHERE id=$1", [teamId])).rows[0].issue_seq,
    101,
  );

  lines[150] = "CSV-150,Row 150,";

  writeFileSync(csv, "ID,Title,Assignee\r\n" + lines.join("\r\n"));
  const fixed = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(fixed.status, 0, fixed.stderr);

  assert(fixed.stdout.includes("201 rows; 101 changed"), fixed.stdout);

  console.log(
    "PASS real CLI integration: failing second batch exits 65, keeps exactly the first 100 rows; fixed rerun commits only the remaining 101 rows.",
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  await gate.query("SELECT pg_advisory_unlock_all()");
  await Promise.allSettled(pendingReplies);
  server.kill("SIGTERM");

  const stopped = await exited;
  if (!failure) assert.equal(stopped.code, 143, JSON.stringify(stopped) + logs);
  rmSync(csv, { force: true });
  if (trigger) {
    await db.query(`DROP TRIGGER ${functionName} ON sync_execution`);
    await db.query(`DROP FUNCTION ${functionName}()`);
  }
  await db.query("DELETE FROM mail_outbox WHERE subject LIKE $1", [prefix + "%"]);
  if (actor) {
    await db.query("DELETE FROM sync_event WHERE stream=ANY($1::text[])", [[actor, peer]]);
    await db.query("DELETE FROM sync_execution WHERE stream=ANY($1::text[])", [[actor, peer]]);
    await db.query("DELETE FROM sync_stream WHERE id=ANY($1::text[])", [[actor, peer]]);

    await db.query("DELETE FROM issue WHERE team_id=$1", [teamId]);
    await db.query("DELETE FROM team_member WHERE team_id=$1", [teamId]);
    await db.query("DELETE FROM team WHERE id=$1", [teamId]);
    await db.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[actor, peer]]);
  }
  await db.end();
  await gate.end();
}
