import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const [mode = "after", action = "move", countText = "1000"] = process.argv.slice(2);
const count = Number(countText);
const profileDirectory = "/home/paseo/plans/issue-board-refactor-flame";

const profileArgs =
  action === "import"
    ? []
    : [
        "--cpu-prof",
        "--cpu-prof-interval=100",
        `--cpu-prof-dir=${profileDirectory}`,
        `--cpu-prof-name=${action}-${mode}.cpuprofile`,
      ];

const directory = mode === "before" ? resolve(".bench/refactor-before") : process.cwd();

const host =
  mode === "before"
    ? resolve(".bench/refactor-before-host/bin/tinker.mjs")
    : resolve("node_modules/@tinker/start/bin/tinker.mjs");

const origin = "http://127.0.0.1:4330";

const env = {
  ...process.env,
  PORT: "4330",
  HOST: "127.0.0.1",
  PUBLIC_ORIGIN: origin,
  AUTH_SECRET: "local-benchmark-secret-at-least-thirty-two-letters",
  DATABASE_URL: "postgres://issue_board@127.0.0.1:15433/postgres",
  SMTP_URL: "smtp://127.0.0.1:11026",
  SMTP_FROM: "board@example.test",
};

const socketUrl = new URL("postgres://issue_board@localhost:15433/postgres");
socketUrl.searchParams.set("host", resolve("../../../../.local/share/issue-board-tools"));
env.DATABASE_URL = socketUrl.href;

Object.assign(env, {
  OTEL_SERVICE_NAME: "issue-board",
  VICTORIA_TRACES_URL: "http://127.0.0.1:11428/insert/opentelemetry/v1/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:19428/insert/opentelemetry/v1/logs",
});

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();

const server = spawn(process.execPath, [...profileArgs, host, "serve"], {
  cwd: directory,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";

server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});

server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const exited = new Promise((done) => server.once("exit", (code, signal) => done({ code, signal })));

try {
  const deadline = AbortSignal.timeout(30_000);
  while (true) {
    deadline.throwIfAborted();
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (server.exitCode !== null) throw Error(output);
    await new Promise((done) => setTimeout(done, 30));
  }
  await db.query(
    'TRUNCATE TABLE "user",team,sync_stream,sync_execution,sync_event,mail_outbox RESTART IDENTITY CASCADE',
  );

  await db.query("INSERT INTO sync_stream(id) VALUES('public') ON CONFLICT DO NOTHING");

  const signup = await fetch(origin + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      name: "Bench actor",
      email: "bench-actor@example.test",
      password: "bench-password-42",
    }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const actor = (
    await db.query('SELECT id FROM "user" WHERE email=$1', ["bench-actor@example.test"])
  ).rows[0].id;
  const teamId = "00000000-0000-4000-8000-000000000001";
  const issueId = "00000000-0000-4000-8000-000000000002";
  await db.query('INSERT INTO "user"(id,name,email) VALUES ($1,$1,$2)', [
    "bench-peer",
    "bench-peer@example.test",
  ]);
  await db.query("INSERT INTO team(id,key,name,issue_seq) VALUES($1,'BENCH','Bench',1)", [teamId]);
  await db.query(
    "INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'admin'),($1,'bench-peer','member')",
    [teamId, actor],
  );
  await db.query(
    "INSERT INTO issue(id,team_id,number,title,creator_id,rank) VALUES($1,$2,1,'Bench issue',$3,'a0')",
    [issueId, teamId, actor],
  );
  const built = readFileSync(resolve(directory, "dist/server/server.js"), "utf8");
  const ids = {};
  for (const name of ["updateIssue", "postComment"]) {
    ids[name] = new RegExp(
      '"([a-f0-9]{64})": \\{\\s+functionName: "' + name + '_createServerFn_handler"',
    ).exec(built)?.[1];
    assert(ids[name], name);
  }
  const require = createRequire(import.meta.url);
  const startRequire = createRequire(require.resolve("@tanstack/react-start/package.json"));
  const clientRequire = createRequire(
    startRequire.resolve("@tanstack/start-client-core/package.json"),
  );
  const { toJSONAsync } = await import(pathToFileURL(clientRequire.resolve("seroval")));

  let version = 1;
  if (action !== "import") {
    assert(["move", "comment"].includes(action));
    for (let i = 0; i < count; i += 1) {
      const executionId = crypto.randomUUID();
      const data =
        action === "move"
          ? {
              executionId,
              change: {
                kind: "move",
                teamId,
                id: issueId,
                version,
                state: i % 2 ? "backlog" : "in_progress",
                beforeId: null,
              },
            }
          : { executionId, comment: { teamId, issueId, body: "Benchmark comment" } };
      const body = JSON.stringify(await toJSONAsync({ data }));

      const response = await fetch(
        origin + "/_serverFn/" + ids[action === "move" ? "updateIssue" : "postComment"],
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tsr-serverFn": "true",
            accept: "application/json",
            origin,
            cookie,
          },
          body,
        },
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert(
        text.includes("accepted") && text.includes(executionId),
        `request ${i}, version ${version}: ${text}\n${output}`,
      );
      if (action === "move") version += 1;
    }
  }
  if (action === "move") {
    assert.equal(
      (await db.query("SELECT version FROM issue WHERE id=$1", [issueId])).rows[0].version,
      count + 1,
    );
  }
  if (action === "comment") {
    assert.equal(
      Number(
        (await db.query("SELECT count(*) FROM comment WHERE issue_id=$1", [issueId])).rows[0].count,
      ),
      count,
    );
  }
  const csv = resolve(".bench/refactor-201.csv");
  writeFileSync(csv, readFileSync("maintain/import-201.csv"));
  if (action === "import") {
    await db.query("DELETE FROM sync_event");
    await db.query("DELETE FROM sync_execution");
    await db.query("DELETE FROM mail_outbox");

    await db.query("DELETE FROM issue WHERE external_id IS NOT NULL");
    await db.query("UPDATE team SET issue_seq=1 WHERE id=$1", [teamId]);
    const cli = spawnSync(
      process.execPath,
      [
        "--cpu-prof",
        "--cpu-prof-interval=100",
        `--cpu-prof-dir=${profileDirectory}`,
        `--cpu-prof-name=import-${mode}.cpuprofile`,
        mode === "before" ? resolve(directory, "cli.mjs") : "maintain/cli.mjs",
        "--file",
        csv,
        "--team",
        "BENCH",
        "--actor",
        "bench-actor@example.test",
      ],
      { cwd: directory, env, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^Imported 201 rows; 201 changed\.$/m);
    assert.equal(
      Number(
        (await db.query("SELECT count(*) FROM issue WHERE external_id IS NOT NULL")).rows[0].count,
      ),
      201,
    );
  }
  const report = {
    mode,
    action,
    runs: action === "import" ? 1 : count,
    rows: action === "import" ? 201 : undefined,
    node: process.version,
    fixture: "maintain/import-201.csv",
    sha256: createHash("sha256").update(readFileSync("maintain/import-201.csv")).digest("hex"),
    samplingIntervalMicroseconds: 100,
    includesStartup: true,
  };
  writeFileSync(
    `${profileDirectory}/${action}-${mode}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  server.kill("SIGTERM");
  const stopped = await exited;
  assert.equal(stopped.code, mode === "before" ? 0 : 143, output);
  await db.end();
}
