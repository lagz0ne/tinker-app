import { capsule, tag, transport } from "@tinker/core";
import type { Ns, Operation, RunResult, Scope } from "@tinker/core";

import { backendStop, requestStop } from "./lifetime";

/** One row of the route table: "METHOD /path/{param}" names the operation that answers it. */
export type Routes = Readonly<Record<`${string} /${string}`, Operation.Handle<any, any>>>;

/**
 * The request a route operation answers; bound per request, read only by HTTP-aware ops. It is
 * Core's own tag, so an op reads it the same under a route and under any rpc transport.
 */
const request = transport.request;

/**
 * Sends the reply before the route operation ends. A stream's operation replies with its body,
 * then keeps running, and so keeps its own session, until the stream ends.
 */
const reply = tag<(response: Response) => void>({ label: "routes.reply" });

/**
 * A row's namespace, bound by the capsule that owns its op: `routes.ns({ op, ns })`. Each
 * request of that row runs in it; in a quiet one it makes no span or log line, failures too.
 */
const ns = tag<{ readonly op: Routes[keyof Routes]; readonly ns: Ns }>({ label: "routes.ns" });

const table = tag<Routes>({ label: "routes.table" });

/** A failure's kind picks its status; any other kind is 500. */
const failures: Readonly<Record<string, number>> = { DataValidationFailed: 400, Cancelled: 503 };

/**
 * The cmd's one route table, compiled once at start: method + URLPattern per row. A route's
 * raw input is its query plus its path params. Its reply: a Response as is, nothing as 204, a
 * value as JSON. Bad input is 400, a cancel 503, anything else 500. No row: undefined. A route
 * that sent its reply early has answered: how its operation ends later changes no reply.
 * Each request runs in its own session of `scope`: a valid `traceparent` makes the route's span
 * its child; no header, or a bad one, starts a fresh trace. An early reply leaves that session
 * open until the run ends. A row whose op has a `routes.ns` binding opens it in that namespace.
 * A subflow the route op does not await is cut off when the run ends: Core aborts its signal.
 * To keep work running past the reply, reply with `reply` and await that work in the op.
 * Only the first reply counts. After an early `reply`, a second `reply` is dropped; a Response
 * the op returns is dropped too, and its body is cancelled. An op that replies with a stream must
 * close or error it in a `finally`: if the op throws first, the client waits for the 60 s idle
 * timeout.
 */
export const routes = capsule({
  label: "routes",
  config: { table: table.required, stop: backendStop.required, ns: ns.all },
  exports: { request, reply, ns, stop: requestStop },
  hooks: {
    async start({ config, next }) {
      await next();

      const rows = Object.entries(config.table).map(([key, op]) => {
        const [method, pathname] = key.split(" ") as [string, string];
        const pattern = new URLPattern({ pathname: pathname.replaceAll(/\{(\w+)\}/g, ":$1") });
        return { method, pattern, op, ns: config.ns.find((row) => row.op === op)?.ns };
      });

      /** A `serve` handler (ADR 0132 in tinkered): the table's answer, or undefined. */
      const fetch = async (
        incoming: Request,
        scope: Scope.Handle,
      ): Promise<Response | undefined> => {
        const url = new URL(incoming.url);
        const row = rows.find((row) => row.method === incoming.method && row.pattern.test(url));
        if (!row) return undefined;

        const params = row.pattern.exec(url)!.pathname.groups;
        const signal = AbortSignal.any([incoming.signal, config.stop]);
        const trace = transport.traceparentOf(incoming.headers.get("traceparent"));
        const early = Promise.withResolvers<Response>();
        // A closing root throws `Disposed` from createSession: answer it as a failed run.
        let session: Scope.Handle | undefined;
        const settled = Promise.resolve()
          .then(() =>
            (session = scope.createSession({ trace, ns: row.ns })).settle(row.op, {
              rawInput: { ...Object.fromEntries(url.searchParams), ...params },
              signal,
              tags: [request(incoming), requestStop(signal), reply(early.resolve)],
            }),
          )
          .catch((error: unknown): RunResult<never> => ({ status: "failed", error, kind: "error" }))
          .finally(() => session?.close())
          .then((result) => {
            if (result.status === "success") {
              const value: unknown = result.value;
              if (value instanceof Response) return value;
              if (value === undefined) return new Response(null, { status: 204 });
              return Response.json(value, { headers: { "Cache-Control": "no-store" } });
            }
            const kind = result.status === "cancelled" ? "Cancelled" : Object(result.error).kind;
            return new Response(null, { status: failures[kind] ?? 500 });
          });

        const winner = await Promise.race([early.promise, settled]);
        // The reply that loses the race answers no one: cancel its body, so a stream stops.
        for (const loser of [early.promise, settled]) {
          void loser.then((late) =>
            late === winner ? undefined : late.body?.cancel().catch(() => undefined),
          );
        }
        return winner;
      };
      return { fetch };
    },
  },
});
