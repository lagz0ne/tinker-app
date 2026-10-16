import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createServer } from "vite-plus";

const vite = await createServer({
  configFile: false,
  cacheDir: ".tinker/proof-import-vite-cache",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { importBatch, importTeam, importActor } = await vite.ssrLoadModule(
  process.env.BOARD_IMPORT_SOURCE ?? "/src/backend/import.server.ts",
);

const { database } = await vite.ssrLoadModule("/tinker/components/database/index.server.ts");
const connectionString = "postgres://issue_board@127.0.0.1:15433/postgres";
const coordinator = new pg.Client({ connectionString });
const observer = new pg.Client({ connectionString });
const prefix = `import-proof-${randomUUID()}`;
const ids = [`${prefix}-a`, `${prefix}-z`, `${prefix}-outsider`];
const teams = [randomUUID(), randomUUID()];
const keys = [`${prefix}-0`, `${prefix}-1`];
const roots = [];
const clients = [];
const stop = new AbortController();
const pending = [];

const sample = {
  externalId: "OLD-1",
  title: "Imported race",
  description: "RFC CSV",
  state: "todo",
  priority: 2,
  assignee: "",
};

const check = process.env.BOARD_PROOF_CASE ?? "all";
let refusal = false;

try {
  await coordinator.connect();
  await observer.connect();
  for (const id of ids) {
    await coordinator.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [
      id,
      `${id}@example.test`,
    ]);
    await coordinator.query("INSERT INTO sync_stream(id) VALUES ($1)", [id]);
  }
  for (let index = 0; index < 2; index += 1) {
    await coordinator.query("INSERT INTO team(id,key,name) VALUES ($1,$2,'Import proof')", [
      teams[index],
      keys[index],
    ]);
  }
  await coordinator.query(
    "INSERT INTO team_member(team_id,user_id,role) VALUES ($1,$3,'member'),($1,$4,'member'),($2,$4,'member'),($2,$3,'member')",
    [...teams, ...ids.slice(0, 2)],
  );
  for (let index = 0; index < 2; index += 1) {
    const client = new pg.Client({ connectionString });
    clients.push(client);
    await client.connect();

    await client.query(
      "SET enable_indexscan=off; SET enable_bitmapscan=off; SET lock_timeout='8s'; SET statement_timeout='12s'",
    );
    const root = createScope({
      signal: stop.signal,
      presets: [preset(database, async () => drizzle({ client }))],
      tags: [importTeam(keys[index]), importActor(`${ids[index]}@example.test`)],
    });
    roots.push(root);
    await root.ready;
  }
  const pids = await Promise.all(
    clients.map(
      async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    ),
  );
  if (["all", "locks", "team"].includes(check)) {
    await coordinator.query("BEGIN");
    await coordinator.query("SELECT id FROM team WHERE id=ANY($1::uuid[]) FOR NO KEY UPDATE", [
      teams,
    ]);
    await coordinator.query("SAVEPOINT streams");

    await coordinator.query("SELECT id FROM sync_stream WHERE id=$1 FOR UPDATE", [ids[0]]);
    const writes = roots.map((root) => root.run(importBatch, { rawInput: { rows: [sample] } }));
    const outcomes = Promise.allSettled(writes);
    pending.push(outcomes);
    const deadline = AbortSignal.timeout(15_000);
    let blocked = 0;
    while (blocked !== 2) {
      deadline.throwIfAborted();
      blocked = (
        await observer.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock' AND query LIKE '%sync_stream%'",
          [pids],
        )
      ).rows[0].n;
    }
    await observer.query("BEGIN");
    try {
      await observer.query("SELECT id FROM sync_stream WHERE id=$1 FOR UPDATE NOWAIT", [ids[1]]);
    } finally {
      await observer.query("ROLLBACK");
    }
    await coordinator.query("ROLLBACK TO SAVEPOINT streams");
    let writer;
    while (!writer) {
      deadline.throwIfAborted();
      writer = (
        await observer.query(
          "SELECT query FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock' AND query LIKE '%team%' AND query NOT LIKE '%sync_stream%'",
          [pids],
        )
      ).rows[0];
    }
    assert(writer.query.includes("for no key update"), writer.query);
    await coordinator.query("COMMIT");
    for (const result of await outcomes) {
      assert.equal(result.status, "fulfilled", String(result.reason));
    }
    console.log(
      "PASS import locks: opposite member heap orders still lock a then z; no team row lock before streams; real team NO KEY UPDATE wait observed.",
    );
  }

  if (["all", "membership"].includes(check)) {
    await coordinator.query("BEGIN");
    await coordinator.query("SELECT id FROM sync_stream WHERE id=$1 FOR UPDATE", [ids[0]]);
    const writing = roots[0].settle(importBatch, {
      rawInput: { rows: [{ ...sample, externalId: "JOIN-RACE" }] },
    });
    pending.push(writing);
    const deadline = AbortSignal.timeout(15_000);
    let waiting = false;
    while (!waiting) {
      deadline.throwIfAborted();
      waiting =
        (
          await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND query LIKE '%sync_stream%'",
            [pids[0]],
          )
        ).rowCount === 1;
    }

    await coordinator.query(
      "INSERT INTO team_member(team_id,user_id,role) VALUES($1,$2,'member')",
      [teams[0], ids[2]],
    );
    await coordinator.query("COMMIT");
    const outcome = await writing;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error.kind, "TeamChanged");
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS n FROM issue WHERE team_id=$1 AND external_id='JOIN-RACE'",
          [teams[0]],
        )
      ).rows[0].n,
      0,
    );
    await coordinator.query("DELETE FROM team_member WHERE team_id=$1 AND user_id=$2", [
      teams[0],
      ids[2],
    ]);
    console.log(
      "PASS import membership race: a join while the import waits makes it refuse TeamChanged; no partial member event set commits.",
    );
  }

  if (["all", "effects", "replay", "rollback"].includes(check)) {
    const row = { ...sample, externalId: "REPLAY" };
    const options = { rawInput: { rows: [row] }, tags: importTeam(keys[0]) };
    const writes = (check === "rollback" ? roots.slice(0, 1) : roots).map((root) =>
      root.run(importBatch, options),
    );
    const outcomes = Promise.allSettled(writes);
    pending.push(outcomes);
    const result = await outcomes;
    assert(
      result.every((entry) => entry.status === "fulfilled"),
      JSON.stringify(result),
    );
    assert.deepEqual(
      result.map((entry) => entry.value.changed).sort((a, b) => a - b),
      check === "rollback" ? [1] : [0, 1],
    );
    const saved = (
      await observer.query("SELECT * FROM issue WHERE team_id=$1 AND external_id='REPLAY'", [
        teams[0],
      ])
    ).rows;
    assert.equal(saved.length, 1);
    const issueId = saved[0].id;
    const events = (
      await observer.query("SELECT * FROM sync_event WHERE payload->'change'->'issue'->>'id'=$1", [
        issueId,
      ])
    ).rows;
    assert.deepEqual(
      events.map((entry) => entry.stream).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ids.slice(0, 2),
    );
    assert(events.every((entry) => entry.payload.change.kind === "issue.upsert"));
    const alerts = (
      await observer.query("SELECT * FROM mail_outbox WHERE subject=$1", [
        `${keys[0]}-${saved[0].number}: Imported race`,
      ])
    ).rows;
    assert.equal(alerts.length, 1);
    assert.notEqual(alerts[0].to, `${ids[2]}@example.test`);
    const before = JSON.stringify({ saved, events, alerts });
    assert.equal((await roots[0].run(importBatch, options)).changed, 0);
    const after = {
      saved: (await observer.query("SELECT * FROM issue WHERE id=$1", [issueId])).rows,
      events: (
        await observer.query(
          "SELECT * FROM sync_event WHERE payload->'change'->'issue'->>'id'=$1",
          [issueId],
        )
      ).rows,
      alerts: (
        await observer.query("SELECT * FROM mail_outbox WHERE subject=$1", [
          `${keys[0]}-${saved[0].number}: Imported race`,
        ])
      ).rows,
    };
    assert.equal(JSON.stringify(after), before);
    const numbers = (
      await observer.query("SELECT number FROM issue WHERE team_id=$1 ORDER BY number", [teams[0]])
    ).rows.map((entry) => entry.number);
    assert.deepEqual(
      numbers,
      Array.from({ length: numbers.length }, (_, index) => index + 1),
    );
    console.log(
      "PASS import race/replay: two Postgres writers, one external-ID row/counter increment; both member streams, one peer alert, zero outsider/public events; replay changes no row/event/mail.",
    );

    assert.equal(
      (
        await roots[0].run(importBatch, {
          ...options,
          rawInput: { rows: [{ ...row, title: "Updated import", state: "done" }] },
        })
      ).changed,
      1,
    );
    const [updated] = (await observer.query("SELECT * FROM issue WHERE id=$1", [issueId])).rows;
    assert.equal(updated.number, saved[0].number);
    assert.equal(updated.version, 2);
    assert.equal(updated.state, "done");
    assert.equal(updated.title, "Updated import");
    const changes = (
      await observer.query(
        "SELECT stream FROM sync_event WHERE payload->'change'->'issue'->>'id'=$1 AND payload->'change'->'issue'->>'title'='Updated import'",
        [issueId],
      )
    ).rows;
    assert.deepEqual(
      changes.map((entry) => entry.stream).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ids.slice(0, 2),
    );
    const receipts = (
      await observer.query(
        "SELECT x.result, e.stream, x.stream AS owner FROM sync_execution x JOIN sync_event e ON e.\"executionId\"=x.id WHERE x.stream=ANY($1::text[]) AND e.payload->>'kind'='result'",
        [ids],
      )
    ).rows;
    assert(receipts.length >= 2);
    assert(
      receipts.every(
        (receipt) => receipt.stream === receipt.owner && receipt.result.kind === "complete",
      ),
    );
    console.log(
      "PASS import update: external ID keeps its row and number, moves state, raises version, and sends member changes plus actor-only complete receipts.",
    );

    const counter = (await observer.query("SELECT issue_seq FROM team WHERE id=$1", [teams[0]]))
      .rows[0].issue_seq;
    await coordinator.query(
      `CREATE FUNCTION import_proof_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->'change'->'issue'->>'title'='REFUSE IMPORT PROOF' THEN RAISE EXCEPTION 'refused import event'; END IF; RETURN NEW; END $$`,
    );
    await coordinator.query(
      "CREATE TRIGGER import_proof_refuse BEFORE INSERT ON sync_event FOR EACH ROW EXECUTE FUNCTION import_proof_refuse()",
    );
    refusal = true;
    await assert.rejects(
      roots[0].run(importBatch, {
        rawInput: { rows: [{ ...sample, externalId: "ROLLBACK", title: "REFUSE IMPORT PROOF" }] },
      }),
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS n FROM issue WHERE team_id=$1 AND external_id='ROLLBACK'",
          [teams[0]],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await observer.query("SELECT issue_seq FROM team WHERE id=$1", [teams[0]])).rows[0]
        .issue_seq,
      counter,
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS n FROM mail_outbox WHERE subject LIKE '%REFUSE IMPORT PROOF%'",
        )
      ).rows[0].n,
      0,
    );
    console.log(
      "PASS import rollback: a real event refusal leaves no issue, counter increment, alert, or event.",
    );
  }
} finally {
  await coordinator.query("ROLLBACK").catch(() => {});
  await Promise.allSettled(pending.map((value) => Promise.resolve(value)));
  stop.abort();

  await Promise.all(roots.map((root) => root.closed));
  await Promise.all(clients.map((client) => client.end()));
  if (refusal) {
    await coordinator.query("DROP TRIGGER import_proof_refuse ON sync_event");
    await coordinator.query("DROP FUNCTION import_proof_refuse()");
  }
  await coordinator.query("DELETE FROM mail_outbox WHERE subject LIKE $1", [`${prefix}%`]);
  await coordinator.query("DELETE FROM sync_event WHERE stream=ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM sync_execution WHERE stream=ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM sync_stream WHERE id=ANY($1::text[])", [ids]);
  await coordinator.query("DELETE FROM issue WHERE team_id=ANY($1::uuid[])", [teams]);
  await coordinator.query("DELETE FROM team_member WHERE team_id=ANY($1::uuid[])", [teams]);
  await coordinator.query("DELETE FROM team WHERE id=ANY($1::uuid[])", [teams]);
  await coordinator.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
  await coordinator.end();
  await observer.end();
  await vite.close();
}
