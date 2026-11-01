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

/** The largest call body read, in bytes (1 MiB unset). A bigger one answers 413, and its
 * provider never runs: a `content-length` over it is refused unread, and a body with no length
 * is read only up to it. It must be a positive whole number, or `Infinity` for no cap; anything
 * else (NaN from a bad `Number(env.X)`, 0, -1, 1.5) fails start with `DataValidationFailed`. */
const maxBody = tag<number>({
  label: "rpc.maxBody",
  default: 1_048_576,
  parse: (raw) => {
    const ok = raw === Infinity || (Number.isSafeInteger(raw) && Number(raw) > 0);
    if (!ok) throw new TypeError("not a positive whole number of bytes, or Infinity");
    return Number(raw);
  },
});

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
 * A body over `maxBody` bytes answers 413 with no provider run.
 * A call with an `Origin` header must come from `origin` when it is bound, else from the request
 * URL's origin; a call with none passes.
 * Each call runs in its own session of `scope`: a valid `traceparent` makes the provider's span
 * the tab span's child; no header, or a bad one, starts a fresh trace.
 */
export const rpc = {
  server: capsule({
    label: "rpc",
    config: { api: api.required, provide: provide.required, origin, maxBody },
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
          Object.entries(config.provide).map(([label, provider]) => [
            `POST /rpc/${label}`,
            provider,
          ]),
        );
        return next().then(() => fetch);

        /** A path or method that is not a call answers undefined; the host makes it 404. */
        async function fetch(request: Request, scope: Scope.Handle): Promise<Response | undefined> {
          const url = new URL(request.url);
          const provider = paths.get(`${request.method} ${url.pathname}`);
          if (!provider) return undefined;
          if (![null, new URL(allowed, url).origin].includes(request.headers.get("origin"))) {
            return new Response(null, { status: 403 });
          }

          // Counts the bytes as they come, so a body with no length stops at the cap. A body that
          // errors mid-read is no input, as bad JSON is: the call answers 400.
          const read = await Promise.resolve(request)
            .then(async ({ headers, body }) => {
              if (Number(headers.get("content-length")) > config.maxBody) return undefined;
              const chunks: Uint8Array[] = [];
              let size = 0;
              for await (const chunk of body ?? []) {
                size += chunk.byteLength;
                if (size > config.maxBody) return undefined;
                chunks.push(chunk);
              }
              return {
                rawInput: await new Response(Buffer.concat(chunks)).json().catch(() => undefined),
              };
            })
            .catch(() => ({ rawInput: undefined }));
          if (!read) return new Response(null, { status: 413 });

          const call = {
            rawInput: read.rawInput,
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
