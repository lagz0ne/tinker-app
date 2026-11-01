import { capsule, tag } from "@tinker/core";
import type { Operation, RunResult, Scope } from "@tinker/core";

import { requestStop } from "~/components/requests";
import { routes, traceparent } from "~/components/requests/index.server";

/** The app's contracts, each under its own label: `{ greet }` where `greet.label` is "greet". */
export type Api = Readonly<Record<string, Operation.Handle<any, any>>>;

/** One provider per contract, under the same key. `satisfies Providers<typeof api>` makes a
 * missing one, or one with another input or reply, a type error. */
export type Providers<A extends Api> = { readonly [K in keyof A]: A[K] };

const api = tag<Api>({ label: "rpc.api" });
const provide = tag<Api>({ label: "rpc.provide" });
/** The public origin a tab calls from. Unset, it is the request URL's own origin; behind a TLS
 * proxy that is `http://<host>`, so the app binds its public `https` origin here. A bound value
 * that is not an http(s) URL fails start with `MissingConfig { key: "origin" }`. */
const origin = tag<string | null>({ label: "rpc.origin", default: null });

const local = { role: "handler", explain: "Runs a contract here, on its provider" } as const;

/** What a failed call answers, by kind; any other raised kind is 422. A panic, or a cancel by
 * the tab, has no kind: 500, with no detail. */
const statuses: Readonly<Record<string, number>> = {
  DataValidationFailed: 400,
  Cancelled: 503,
  undefined: 500,
};

/**
 * The server side of `rpc`. A run of a contract op, here or from a tab, runs its provider with
 * the same call. Its start value answers `POST /rpc/<label>`: the JSON body is the raw input, the
 * reply is `{ value }`, and a raised failure keeps its kind and payload (400 for bad input).
 * A call with an `Origin` header must come from `origin` when it is bound, else from the request
 * URL's origin; a call with none passes.
 * Each call runs in its own session of `scope`: a valid `traceparent` makes the provider's span
 * the tab span's child; no header, or a bad one, starts a fresh trace.
 */
export const rpc = {
  server: capsule({
    label: "rpc",
    config: { api: api.required, provide: provide.required, origin },
    hooks: {
      /** Sync, one key read: every op of the root passes through here. */
      run({ op, call, next, run, config }) {
        const label = String(op.label);
        if (config.api[label] !== op) return next();
        return run(config.provide[label]!, call ?? {}, local);
      },

      /** Fails start, before any request, when a contract has no provider or a wrong key. */
      start({ config, next, raise }) {
        for (const [key, contract] of Object.entries(config.api)) {
          if (contract.label !== key) raise("MissingConfig", { label: "rpc", key: `api.${key}` });
          if (!config.provide[key]) raise("MissingConfig", { label: "rpc", key: `provide.${key}` });
        }
        // Unset is "": it resolves to the request URL's own origin. Bound, it must be an
        // http(s) URL: a bad URL is "undefined", and any other scheme's origin is "null" (what
        // a sandboxed page sends) or not http(s).
        const allowed = config.origin === null ? "" : String(URL.parse(config.origin)?.origin);
        if (!/^(https?:\/\/|$)/.test(allowed)) {
          raise("MissingConfig", { label: "rpc", key: "origin" });
        }
        const paths = new Map(
          Object.entries(config.provide).map(([label, provider]) => [`/rpc/${label}`, provider]),
        );
        return next().then(() => fetch);

        /** A path or method that is not a call answers undefined; the host makes it 404. */
        async function fetch(request: Request, scope: Scope.Handle): Promise<Response | undefined> {
          const url = new URL(request.url);
          const provider = request.method === "POST" ? paths.get(url.pathname) : undefined;
          if (!provider) return undefined;
          if (![null, new URL(allowed, url).origin].includes(request.headers.get("origin"))) {
            return new Response(null, { status: 403 });
          }

          const call = {
            rawInput: await request.json().catch(() => undefined),
            signal: request.signal,
            tags: [routes.request(request), requestStop(request.signal)],
          };
          const trace = traceparent.safeParse(request.headers.get("traceparent")).data ?? null;
          // A closing root throws `Disposed` from createSession: answer it as a failed call.
          let session: Scope.Handle | undefined;
          const result = await Promise.resolve()
            .then(() => (session = scope.createSession({ trace })).settle(provider, call))
            .catch((error: unknown): RunResult<never> => ({
              status: "failed",
              error,
              kind: "error",
            }))
            .finally(() => session?.close());

          if (result.status === "success") return Response.json({ value: result.value });
          const { kind, payload } =
            result.status === "failed" ? Object(result.error) : { kind: "Cancelled", payload: {} };
          return Response.json({ kind, payload }, { status: statuses[String(kind)] ?? 422 });
        }
      },
    },
  }),
};
