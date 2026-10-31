import { operation } from "@tinker/core";

import type { Errors } from "~/components/errors";
import { requestStop } from "~/components/requests";

import { greet } from "@/backend/greet";

/** The greeting, read for one request. A cancel raises Cancelled; a failure stays as is. */
export const greetRead = operation({
  label: "transport.greet",
  depends: { read: greet.controller, stop: requestStop.required },
  run: async ({ read, stop }, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const result = await read.settle({ input: { name: "world" }, signal: stop });

    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return raise("Cancelled", {});
    return result.value;
  },
});
