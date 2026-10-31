import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

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
      "~": fileURLToPath(new URL("../tinker", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

const { default: main } = await vite.ssrLoadModule("/cmds/worker.ts");

const connectionString =
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres";

const admin = new pg.Client({ connectionString });

const name = "worker_trace_" + randomUUID().replaceAll("-", "");

let refuse = false;

const packets = [];

const collector = createHttpServer((request, response) => {
  let body = "";

  request.on("data", (data) => {
    body += data;
  });

  request.on("end", () => {
    packets.push({ url: request.url, body });
    response.statusCode = refuse ? 503 : 200;
    response.end();
  });
});

let host;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);

  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));

  const port = collector.address().port;

  for (const mode of ["healthy", "collector-refuses", "work-error"]) {
    refuse = mode !== "healthy";
    packets.length = 0;

    const url = new URL(connectionString);
    url.pathname = "/" + (mode === "work-error" ? name + "_missing" : name);

    let output = "";
    let errors = "";

    const ready = Promise.withResolvers();
    const hard = Promise.withResolvers();

    host = createMainHost(main, {
      env: {
        DATABASE_URL: url.href,
        SMTP_URL: "smtp://127.0.0.1:11026",
        SMTP_FROM: "proof@example.test",
        DIGEST_HOUR_UTC: "0",
        VICTORIA_TRACES_URL: `http://127.0.0.1:${port}/traces`,
        VICTORIA_LOGS_URL: `http://127.0.0.1:${port}/logs`,
        OTEL_SERVICE_NAME: "worker-proof",
      },
      stdout: {
        write(text) {
          output += text;
          if (output.includes('"message":"outbox.batch"')) ready.resolve();
        },
      },
      stderr: {
        write(text) {
          errors += text;
        },
      },
      hardStop: () => hard.resolve("hard-stop"),
    });

    // A startup error throws from main; the host owns its exit code, read below from closed.
    await host.started.catch(() => {});

    if (mode !== "work-error") {
      await Promise.race([
        ready.promise,
        host.closed.then(() => assert.fail("worker must run before its stop")),
      ]);

      host.stop(143);
    }
    const result = await Promise.race([host.closed, hard.promise]);

    assert.notEqual(result, "hard-stop", "worker telemetry must flush or fail before host grace");

    if (mode === "work-error") {
      assert.equal(result, 1, "collector failure must not replace worker error exit");

      assert.match(
        errors,
        /DrizzleQueryError: Failed query: SELECT pg_try_advisory_lock/,
        "collector failure must preserve the actual work error",
      );
    } else {
      assert.equal(result, 143);

      if (mode === "healthy") {
        const groups = packets
          .filter((packet) => packet.url.startsWith("/traces"))
          .flatMap((packet) => JSON.parse(packet.body).resourceSpans);

        assert(groups.length > 0, "worker trace must reach collector");

        assert(
          groups.every((group) =>
            group.resource.attributes.some(
              (attribute) =>
                attribute.key === "tinker.side" && attribute.value.stringValue === "worker",
            ),
          ),
          "worker trace side must be worker",
        );

        const names = groups.flatMap((group) =>
          group.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
        );

        assert(
          names.includes("outbox.worker"),
          "worker trace must include final worker span before telemetry closes",
        );

        assert(
          names.includes("outbox.claim"),
          "worker trace must include its committed claim step",
        );
      }
    }
    console.log(
      "PASS worker telemetry: " +
        mode +
        "; owned close completes; worker side and primary exit retained.",
    );
  }
} finally {
  host?.stop(143);
  await host?.closed;

  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(() => resolve()));

  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  await vite.close();
}
