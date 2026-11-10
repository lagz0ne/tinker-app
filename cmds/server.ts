import { serve, ws } from "@tinker/bun";
import { createScope } from "@tinker/core";

import { defineMain } from "~/base/main";
import { observeServerPanics } from "~/base/panics.server";
import { health } from "~/components/health";
import { routes } from "~/components/requests/index.server";
import { telemetry } from "~/components/telemetry/index.server";

import { greet } from "@/greet";
import { greetOps } from "@/greet/index.server";
import { todo } from "@/todo";
import { todoOps } from "@/todo/index.server";

import { pages } from "./pages";

/** The env's defaults: the dev port when `PORT` is unset. */
const defaults = { PORT: "4318" };

/** The host starts the server; importing this command opens nothing. */
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: bun cmds/host.ts\n");
    exit(64);
    return { closed: Promise.resolve() };
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

  const socket = ws.server({ path: "/rpc", services: [greet.api, todo.board, todo.api], origin });
  const table = routes({
    stop: signal,
    table: {
      "GET /api/health": health,
      "POST /api/telemetry": sink.route,
    },
  });
  const app = createScope({
    signal,
    capsules: [
      serve({
        port: Number({ ...defaults, ...env }.PORT),
        pages,
        websocket: socket,
        handlers: [table],
        development: env.NODE_ENV !== "production",
        stdout,
      }),
      sink,
      greet.api({ implement: greetOps }),
      // The todo feature: the server serves the list and is its only writer.
      todo.board({ serve: true }),
      todo.api({ implement: todoOps }),
      socket,
      table,
    ],
  });

  const live = await app.ready;
  live.onClose(observeServerPanics(exit.bind(null, 1), app.closed, stderr));
  return app;
});
