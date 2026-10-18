import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import pg from "pg";
import { createServer } from "vite-plus";

import { createMainHost } from "../../../packages/start/lib/main-host.mjs";
import { proofFault } from "./proof-fault.mjs";

const vite = await createServer({
  configFile: false,
  plugins: [proofFault()],
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
});

const { database, databaseUrl, databaseConnectTimeout } = await vite.ssrLoadModule(
  "/tinker/components/database/index.server.ts",
);

const { postgres } = await vite.ssrLoadModule("/tinker/components/database/modules.ts");

const { mail } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");

const { runMailPass } = await vite.ssrLoadModule("/src/backend/outbox.server.ts");
const { mailWorkerStop } = await vite.ssrLoadModule("/tinker/components/mail/index.server.ts");

const { tickMailDigest } = await vite.ssrLoadModule("/src/backend/digest.server.ts");

const hard = Promise.withResolvers();

const queued = Promise.withResolvers();

let root;

let host;

let pool;
let closeListen;

try {
  host = createMainHost(
    async ({ signal }) => {
      root = createScope({
        tags: [
          databaseUrl(new URL("postgres://issue_board@127.0.0.1:15433/postgres")),
          databaseConnectTimeout(1000),
          mailWorkerStop(signal),
        ],
        presets: [
          preset(postgres, async () => ({
            default: {
              Pool: function Pool(options) {
                pool = new pg.Pool({ ...options, max: 1 });
                const connect = pool.connect.bind(pool);
                pool.connect = (...args) => {
                  if (pool.totalCount === 1) queued.resolve();
                  return connect(...args);
                };
                return pool;
              },
            },
          })),
          preset(mail, async () => ({
            send: async () => assert.fail("checkout-bound worker must not send"),
          })),
          preset(tickMailDigest, async () => {}),
        ],
      });

      await root.ready;

      const db = await root.resolve(database);

      closeListen = await db.listen(
        () => {},
        () => {},
      );

      return {
        closed: root
          .run(runMailPass)
          .catch(() => {})
          .finally(() => root.close({ graceful: true })),
      };
    },
    {
      env: {},
      stdout: { write() {} },
      stderr: { write() {} },
      hardStop: () => hard.resolve("hard-stop"),
    },
  );

  await host.started;

  await queued.promise;

  host.stop(143);

  assert.notEqual(
    await Promise.race([host.closed, hard.promise]),
    "hard-stop",
    "worker blocked checkout must close before host hard stop",
  );

  assert.equal(pool.totalCount, 0, "worker must release listener and close pool");

  console.log(
    "PASS worker checkout: real one-connection pool is held by LISTEN; checkout fails within budget; graceful stop releases pool before hard stop.",
  );
} finally {
  await closeListen?.();

  await root?.close();

  await pool?.end().catch(() => {});

  await vite.close();
}
