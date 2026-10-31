import { operation } from "@tinker/core";

import type { Errors } from "~/components/errors";
import { health } from "~/components/health";
import { requestStop } from "~/components/requests";

/** The base health, read for one request. A cancel raises Cancelled; a failure stays as is. */
export const healthRead = operation({
  label: "transport.health",
  depends: { read: health.controller, stop: requestStop.required },
  run: async ({ read, stop }, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;
    const result = await read.settle({ signal: stop });

    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return raise("Cancelled", {});
    return result.value;
  },
});
