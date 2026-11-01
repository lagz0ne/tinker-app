import { capsule, tag } from "@tinker/core";
import type { Operation } from "@tinker/core";

import { requestStop } from "~/components/requests";
import { routes } from "~/components/requests/index.server";

/** The app's contracts, each under its own label: `{ greet }` where `greet.label` is "greet". */
export type Api = Readonly<Record<string, Operation.Handle<any, any>>>;

/** One provider per contract, under the same key. `satisfies Providers<typeof api>` makes a
 * missing one, or one with another input or reply, a type error. */
export type Providers<A extends Api> = { readonly [K in keyof A]: A[K] };

const api = tag<Api>({ label: "rpc.api" });
const provide = tag<Api>({ label: "rpc.provide" });

const answer = { role: "handler", explain: "Runs one call from a tab" } as const;
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
 */
export const rpc = {
  server: capsule({
    label: "rpc",
    config: { api: api.required, provide: provide.required },
    hooks: {
      /** Sync, one key read: every op of the root passes through here. */
      run({ op, call, next, run, config }) {
        const label = String(op.label);
        if (config.api[label] !== op) return next();
        return run(config.provide[label]!, call ?? {}, local);
      },

      /** Fails start, before any request, when a contract has no provider or a wrong key. */
      start({ config, settle, next, raise }) {
        for (const [key, contract] of Object.entries(config.api)) {
          if (contract.label !== key) raise("MissingConfig", { label: "rpc", key: `api.${key}` });
          if (!config.provide[key]) raise("MissingConfig", { label: "rpc", key: `provide.${key}` });
        }
        const paths = new Map(
          Object.entries(config.provide).map(([label, provider]) => [`/rpc/${label}`, provider]),
        );
        return next().then(() => fetch);

        /** A path or method that is not a call answers undefined; the host makes it 404. */
        async function fetch(request: Request): Promise<Response | undefined> {
          const url = new URL(request.url);
          const provider = request.method === "POST" ? paths.get(url.pathname) : undefined;
          if (!provider) return undefined;
          if (![null, url.origin].includes(request.headers.get("origin"))) {
            return new Response(null, { status: 403 });
          }

          const call = {
            rawInput: await request.json().catch(() => undefined),
            signal: request.signal,
            tags: [routes.request(request), requestStop(request.signal)],
          };
          const result = await settle(provider, call, answer);

          if (result.status === "success") return Response.json({ value: result.value });
          const { kind, payload } =
            result.status === "failed" ? Object(result.error) : { kind: "Cancelled", payload: {} };
          return Response.json({ kind, payload }, { status: statuses[String(kind)] ?? 422 });
        }
      },
    },
  }),
};
