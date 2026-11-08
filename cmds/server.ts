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

  const live = await app.ready;
  signal.throwIfAborted(); // Aborted during start: app is closing, so no handler.
  live.onClose(observeServerPanics(exit.bind(null, 1), app.closed, stderr));
  const [link, table] = [live.resolve(ws.server), live.resolve(routes)];
  return {
    websocket: link.websocket as never,
    // A key's bytes are the largest body; 1 MiB covers the routes' own JSON bodies.
    maxRequestBodySize: Math.max(link.maxBody, 1_048_576),
    // The socket's path, then a bytes POST, then the route table. null: upgraded; else the answer.
    fetch: async (request: Request, server: Server<never>) => {
      const upgraded = link.upgrade(request, live, server as never);
      if (upgraded !== undefined) return upgraded;
      return (await link.post(request, live)) ?? table(request, live);
    },
    closed: app.closed,
  };
});
