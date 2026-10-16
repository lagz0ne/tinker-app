import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";

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

const connectionString = "postgres://issue_board@127.0.0.1:15433/postgres";
const reader = new pg.Client({ connectionString });
const writer = new pg.Client({ connectionString });
const schema = "snapshot_" + randomUUID().replaceAll("-", "");
let root;

try {
  await reader.connect();
  await writer.connect();
  await writer.query(`CREATE SCHEMA ${schema}`);
  for (const client of [reader, writer]) await client.query(`SET search_path TO ${schema}`);
  await writer.query(
    "CREATE TABLE sync_stream(id text PRIMARY KEY, revision integer NOT NULL); CREATE TABLE public_counter(id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO sync_stream VALUES('public',0); INSERT INTO public_counter VALUES(1,0)",
  );

  const { database } = await vite.ssrLoadModule("/tinker/components/database/index.server.ts");
  const { bootstrapPublic } = await vite.ssrLoadModule("/src/demo/backend/sync.server.ts");
  let writes = 0;
  const queries = [];
  const client = new Proxy(reader, {
    get(target, key) {
      if (key !== "query") return Reflect.get(target, key, target);
      return async (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0].text;
        queries.push(text);
        const result = await target.query(...args);
        if (/^select .*"sync_stream"/i.test(text)) {
          await writer.query("BEGIN");
          await writer.query(
            "UPDATE public_counter SET value=value+1; UPDATE sync_stream SET revision=revision+1",
          );
          await writer.query("COMMIT");
          writes += 1;
        }
        return result;
      };
    },
  });
  root = createScope({ presets: [preset(database, async () => drizzle({ client }))] });
  await root.ready;
  for (let pass = 0; pass < 3; pass += 1) {
    const result = await root.run(bootstrapPublic);
    assert.equal(result.revision, pass);
    assert.equal(result.value, result.revision, "bootstrap data must match its revision snapshot");
  }

  assert(
    queries.some((query) => /read only/i.test(query)),
    "bootstrap transaction must be read-only",
  );

  assert.equal(writes, 3, "writer must commit between each revision and data read");
  assert(
    !queries.some((query) => /\bfor\s+(update|share|no key update|key share)\b/i.test(query)),
    "reader must use no row locks",
  );
  console.log(
    "PASS two PostgreSQL clients: bootstrap revision and data share one read-only snapshot across three intervening commits.",
  );
} finally {
  await root?.close({ graceful: true });
  await reader.query("ROLLBACK").catch(() => {});
  await writer.query("ROLLBACK").catch(() => {});
  await writer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});

  await reader.end();
  await writer.end();
  await vite.close();
}
