import { pathToFileURL } from "node:url";

import { createServer } from "vite";

/**
 * A second OS process for the SQLite proofs: it loads the app's TypeScript, `~` aliases and
 * `.sql` files through Vite's SSR loader, then runs the real component's work.
 * The parent passes `SQLITE_CHILD` as JSON and reads one JSON line back.
 */
const request = JSON.parse(process.env.SQLITE_CHILD ?? "{}");

const server = await createServer({
  configFile: new URL("../../vitest.config.ts", import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const { createScope } = await server.ssrLoadModule("@tinker/core");
  const { databaseUrl, databaseMigrationsFolder, migrate, transaction } =
    await server.ssrLoadModule("/tinker/components/database-sqlite/index.server.ts");
  const { eventHistory } = await server.ssrLoadModule(
    "/tinker/components/sync-sqlite/index.server.ts",
  );

  const tags = [databaseUrl(pathToFileURL(request.db))];

  if (request.folder) tags.push(databaseMigrationsFolder(request.folder));

  const root = createScope({ tags });

  try {
    if (request.action === "migrate") await root.run(migrate);
    else if (request.action === "notify") {
      await root.session(async (session) => {
        const tx = await session.resolve(transaction);

        await tx.notify(request.channel, request.payload);
      });
    } else if (request.action === "append") {
      await root.session(async (session) => {
        const tx = await session.resolve(transaction);
        const history = await session.resolve(eventHistory);

        await history.append(tx, request.owner, request.executionId, [
          { kind: "change", change: request.change },
        ]);
      });
    } else throw new Error(`unknown action ${request.action}`);
  } finally {
    await root.close({ graceful: true });
  }

  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} finally {
  await server.close();
}
