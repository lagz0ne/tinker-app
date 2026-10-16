import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";
import { writeDatabase, writeDispatch } from "./proof-write.mjs";

const vite = await createServer({
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

const { changeIssue } = await vite.ssrLoadModule("/src/backend/issues.server.ts");
const { currentUser } = await vite.ssrLoadModule("/src/demo/backend/auth.server.ts");

const { database } = await vite.ssrLoadModule("/tinker/components/database/index.server.ts");

const dispatch = writeDispatch();

const client = new pg.Client({
  connectionString: "postgres://issue_board@127.0.0.1:15433/postgres",
});

await client.connect();

const actor = (
  await client.query('SELECT * FROM "user" WHERE email=$1', ["bench-actor@example.test"])
).rows[0];

const saved = (
  await client.query("SELECT * FROM issue WHERE id='00000000-0000-4000-8000-000000000002'")
).rows[0];

const stop = new AbortController();

const root = createScope({
  signal: stop.signal,
  observe: { history: 1000 },
  presets: [
    preset(database, async () => writeDatabase(client)),
    preset(currentUser, async () => actor),
  ],
});

await root.ready;

try {
  await dispatch.run(root, changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: {
        kind: "move",
        teamId: saved.team_id,
        id: saved.id,
        version: saved.version,
        state: saved.state === "backlog" ? "in_progress" : "backlog",
        beforeId: null,
      },
    },
    signal: stop.signal,
  });
  console.log(JSON.stringify(root.spans(), null, 2));
} finally {
  stop.abort();
  await root.closed;
  await client.end();
  await vite.close();
}
