import { capsule, tag } from "@tinker/core";
import type { Operation, RunResult, Scope } from "@tinker/core";

import { backendStop, requestStop } from "./lifetime";
import { traceparent } from "./trace.server";

/** One row of the route table: "METHOD /path/{param}" names the operation that answers it. */
export type Routes = Readonly<Record<`${string} /${string}`, Operation.Handle<any, any>>>;

/** The request a route operation answers; bound per request, read only by HTTP-aware ops. */
const request = tag<Request>({ label: "routes.request" });

const table = tag<Routes>({ label: "routes.table" });

/** A failure's kind picks its status; any other kind is 500. */
const failures: Readonly<Record<string, number>> = { DataValidationFailed: 400, Cancelled: 503 };

/**
 * The cmd's one route table, compiled once at start: method + URLPattern per row. A route's
 * raw input is its query plus its path params. Its reply: a Response as is, nothing as 204, a
 * value as JSON. Bad input is 400, a cancel 503, anything else 500. No row: undefined.
 * Each request runs in its own session of `scope`: a valid `traceparent` makes the route's span
 * its child; no header, or a bad one, starts a fresh trace.
 */
export const routes = capsule({
  label: "routes",
  config: { table: table.required, stop: backendStop.required },
  exports: { request, stop: requestStop },
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
        // A closing root throws `Disposed` from createSession: answer it as a failed run.
        let session: Scope.Handle | undefined;
        const result = await Promise.resolve()
          .then(() =>
            (session = scope.createSession({ trace })).settle(row.op, {
              rawInput: { ...Object.fromEntries(url.searchParams), ...params },
              signal,
              tags: [request(incoming), requestStop(signal)],
            }),
          )
          .catch((error: unknown): RunResult<never> => ({ status: "failed", error, kind: "error" }))
          .finally(() => session?.close());

        if (result.status === "success") {
          const value: unknown = result.value;
          if (value instanceof Response) return value;
          if (value === undefined) return new Response(null, { status: 204 });
          return Response.json(value, { headers: { "Cache-Control": "no-store" } });
        }
        const kind = result.status === "cancelled" ? "Cancelled" : Object(result.error).kind;
        return new Response(null, { status: failures[kind] ?? 500 });
      };
    },
  },
});
