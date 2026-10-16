import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

const path = process.env.BOARD_PROOF_LEASE_COPY ?? "tinker/components/database/lease.server.ts";
const { leaseFrom } = await import(pathToFileURL(resolve(path)).href);
const queries = [];
const releases = [];
const pending = Promise.withResolvers();
const refused = Object.assign(new Error("TransactionEnded"), { kind: "TransactionEnded" });
let ended = false;
let acquired = 0;

const connection = {
  query: async (config) => {
    queries.push(config);
    return { rows: [], rowCount: 0 };
  },
  release: (broken) => releases.push(broken),
};

const lease = leaseFrom(
  async () => {
    acquired += 1;
    return connection;
  },
  drizzle,
  {
    check() {
      if (ended) throw refused;
    },
    begin() {
      if (ended) throw refused;
      return pending.promise;
    },
  },
);

assert.equal(acquired, 0, "unused transaction must not check out a connection");
lease.release();
assert.deepEqual(releases, [], "unused transaction must not release a connection");

const waiting = Promise.resolve(lease.db.execute(sql`SELECT 1`));
await new Promise((done) => setImmediate(done));
assert.equal(queries.length, 0, "real checkout must await BEGIN guard before the query");
assert.equal(acquired, 0, "pool checkout must wait until BEGIN starts");
pending.resolve();
await waiting;
assert.equal(queries.length, 1);
assert.equal(acquired, 1);
ended = true;

await assert.rejects(
  async () => lease.db.execute(sql`SELECT 2`),
  (error) => error === refused,
  "real checkout must reject ended queries before Drizzle wraps them",
);

assert.equal(queries.length, 1);
lease.release(true);
assert.deepEqual(releases, [true], "real checkout must forward broken release(true)");
console.log("PASS real shared checkout: await BEGIN, typed ended query, release(true).");
