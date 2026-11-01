import { capsule, tag } from "@tinker/core";
import type { Operation, RunResult, Scope } from "@tinker/core";

import { backendStop, requestStop } from "./lifetime";
import { traceparent } from "./trace.server";

/** One row of the route table: "METHOD /path/{param}" names the operation that answers it. */
export type Routes = Readonly<Record<`${string} /${string}`, Operation.Handle<any, any>>>;

/** The request a route operation answers; bound per request, read only by HTTP-aware ops. */
const request = tag<Request>({ label: "routes.request" });

/**
 * Sends the reply before the route operation ends. A stream's operation replies with its body,
 * then keeps running, and so keeps its own session, until the stream ends.
 */
const reply = tag<(response: Response) => void>({ label: "routes.reply" });

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
 * open until the run ends.
 */
export const routes = capsule({
  label: "routes",
  config: { table: table.required, stop: backendStop.required },
  exports: { request, reply, stop: requestStop },
  hooks: {
    async start({ config, next }) {
      await next();

      const rows = Object.entries(config.table).map(([key, op]) => {
        const [method, pathname] = key.split(" ") as [string, string];
        const pattern = new URLPattern({ pathname: pathname.replaceAll(/\{(\w+)\}/g, ":$1") });
        return { method, pattern, op };
      });

      return async function fetch(
        incoming: Request,
        scope: Scope.Handle,
      ): Promise<Response | undefined> {
        const url = new URL(incoming.url);
        const row = rows.find((row) => row.method === incoming.method && row.pattern.test(url));
        if (!row) return undefined;

        const params = row.pattern.exec(url)!.pathname.groups;
        const signal = AbortSignal.any([incoming.signal, config.stop]);
        const trace = traceparent.safeParse(incoming.headers.get("traceparent")).data ?? null;
        const early = Promise.withResolvers<Response>();
        // A closing root throws `Disposed` from createSession: answer it as a failed run.
        let session: Scope.Handle | undefined;
        const settled = Promise.resolve()
          .then(() =>
            (session = scope.createSession({ trace })).settle(row.op, {
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

        return Promise.race([early.promise, settled]);
      };
    },
  },
});
