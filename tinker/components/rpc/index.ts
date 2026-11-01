import { capsule, tag } from "@tinker/core";
import type { Operation } from "@tinker/core";

import type { Errors } from "~/components/errors";
import { httpBackend } from "~/components/http";

/** The app's contracts, each under its own label. A run of one goes to the server, the same call. */
const api = tag<Readonly<Record<string, Operation.Handle<any, any>>>>({ label: "rpc.api" });

/** Where the server's rpc route answers: one POST per call, `<base>/<label>`. */
const base = tag<string>({ label: "rpc.base", default: "/rpc" });

/**
 * The browser side of `rpc`. It holds no implementation, and its start does no network work. A run of a listed op skips the local
 * body: its input goes to the server as JSON, and the reply is the run's value. A failure the
 * server raised comes back with the same kind and payload; anything else is `RpcFailed`.
 */
export const rpc = {
  client: capsule({
    label: "rpc",
    config: { api: api.required, base, send: httpBackend },
    hooks: {
      /** Not async: a run hook's promise would turn every sync op of the tab async. */
      run({ op, call, next, config, signal, raise: coreRaise }) {
        const label = String(op.label);
        if (config.api[label] !== op) return next();
        const raise: Errors.Raise = coreRaise;
        const { input, rawInput, signal: own } = call ?? {};

        return config
          .send(`${config.base}/${label}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input ?? rawInput ?? null),
            signal: AbortSignal.any([signal, own ?? signal]),
          })
          .then(async (response) => {
            const body = await response.json().catch(() => undefined);
            if (response.ok) return body?.value;

            const failure = Object(body);
            if (typeof failure.kind === "string") {
              throw Object.assign(new Error(failure.kind), failure);
            }
            return raise("RpcFailed", { label, status: response.status });
          });
      },
    },
  }),
};
