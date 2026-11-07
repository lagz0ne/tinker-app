import { createScope } from "@tinker/core";
import type { Server } from "bun";

import { defineMain } from "~/base/main";
import { observeServerPanics } from "~/base/panics.server";
import { health } from "~/components/health";
import { routes } from "~/components/requests/index.server";
import { telemetry } from "~/components/telemetry/index.server";
import { ws } from "~/components/ws/index.server";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";

/** The host starts the server; importing this command opens nothing. */
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: bun cmds/host.ts\n");
    exit(64);
    return { fetch: async () => undefined, websocket: undefined, closed: Promise.resolve() };
  }

  // Behind a TLS proxy the request URL is http: calls and tab batches must come from the public
  // origin. Empty (`PUBLIC_ORIGIN=` from a compose file or an env form) counts as unset.
  const origin = env.PUBLIC_ORIGIN || undefined;
  /** A built server sends telemetry from a worker thread; dev and tests keep it on this thread. */
  const sends = {
    service: env.OTEL_SERVICE_NAME,
    tracesUrl: env.VICTORIA_TRACES_URL === undefined ? undefined : new URL(env.VICTORIA_TRACES_URL),
    logsUrl: env.VICTORIA_LOGS_URL === undefined ? undefined : new URL(env.VICTORIA_LOGS_URL),
    console: stdout,
    level: env.LOG_LEVEL === undefined ? undefined : Number(env.LOG_LEVEL),
    history: env.SPAN_HISTORY === undefined ? undefined : Number(env.SPAN_HISTORY),
    origin,
  };
  const sink =
    env.NODE_ENV === "production"
      ? telemetry.thread({ ...sends, worker: new URL("./telemetry-worker.js", import.meta.url) })
      : telemetry.server(sends);

  const app = createScope({
    signal,
    capsules: [
      sink,
      api({ implement: { greet: greetHere } }),
      ws.server({ path: "/rpc", services: [api], origin }),
      routes({
        stop: signal,
        table: {
          "GET /api/health": health,
          "POST /api/telemetry": sink.route,
        },
      }),
    ],
  });

  await app.ready;
  signal.throwIfAborted(); // Aborted during start: app is closing, so no handler.
  app.onClose(observeServerPanics(exit.bind(null, 1), app.closed, stderr));
  const [{ upgrade, websocket }, table] = [app.resolve(ws.server), app.resolve(routes)];
  return {
    websocket: websocket as never,
    // undefined: not the socket's path, so the route table; null: upgraded; else its answer.
    fetch: async (request: Request, server: Server<never>) => {
      const upgraded = upgrade(request, app, server as never);
      return upgraded === undefined ? table(request, app) : upgraded;
    },
    closed: app.closed,
  };
});
