import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createServer } from "vite-plus";

const { createMainHost } = await import(
  process.env.BOARD_EXIT_HOST_COPY
    ? pathToFileURL(resolve(process.env.BOARD_EXIT_HOST_COPY)).href
    : import.meta.resolve("@tinker/start/main-host")
);

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
    },
  },
  plugins: [
    {
      name: "proof:close-failure",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/cmds/server.ts") && process.env.BOARD_EXIT_SERVER_COPY) {
          return readFileSync(process.env.BOARD_EXIT_SERVER_COPY, "utf8");
        }
        if (!id.endsWith("/tinker/components/database/database.server.ts")) return;
        const start = code.indexOf("export const databaseSetup =");
        const end = code.indexOf("/** The call's session", start);
        return (
          code.slice(0, start) +
          `export let proofClose;
      export const databaseSetup = extension({ label:"proof.close", hooks:{async start({next,scope}) {
        await next(); scope.onClose(()=>{throw new Error("proof server teardown failure");});
        proofClose=scope.close.bind(scope);
      }}});
      ` +
          code.slice(end)
        );
      },
    },
  ],
});

try {
  const { default: main } = await vite.ssrLoadModule("/cmds/server.ts");

  let errors = "";

  let serving = false;

  const host = createMainHost(main, {
    env: {
      PUBLIC_ORIGIN: "http://localhost:4327",
      AUTH_SECRET: "proof-secret-with-at-least-thirty-two-letters",
      DATABASE_URL: "postgres://proof@localhost/proof",
      SMTP_URL: "smtp://localhost:11026",
      SMTP_FROM: "proof@example.test",
      OTEL_SERVICE_NAME: "proof",
      VICTORIA_TRACES_URL: "http://localhost:11428",
      VICTORIA_LOGS_URL: "http://localhost:19428",
    },
    stdout: { write() {} },
    stderr: {
      write(text) {
        errors += text;
      },
    },
    onStart: async () => {
      serving = true;
      const { proofClose } = await vite.ssrLoadModule(
        "/tinker/components/database/database.server.ts",
      );
      await proofClose({ graceful: true });
    },
  });

  assert.equal(await host.closed, 1, "served server close failure must exit 1");

  assert(serving, "server must finish start before close fails");

  const reason = host.signal.reason;

  assert.equal(
    errors,
    `command failed (exit 1): ${reason.stack}\n`,
    "server close failure must print its reason exactly once",
  );

  assert(errors.includes("proof server teardown failure"), errors);

  console.log("PASS served server close failure exits 1 and prints its stack exactly once.");
} finally {
  await vite.close();
}
