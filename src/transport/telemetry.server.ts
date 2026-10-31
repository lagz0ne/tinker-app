import { operation } from "@tinker/core";
import { z } from "zod";

import type { Errors } from "~/components/errors";
import { requestStop } from "~/components/requests";
import { receiveTelemetry } from "~/components/telemetry/index.server";

/** One browser batch, received for one request. A cancel raises Cancelled; a failure stays as is. */
export const telemetryReceive = operation({
  label: "transport.telemetry",
  input: z.unknown(),
  depends: { read: receiveTelemetry.controller, stop: requestStop.required },
  run: async ({ read, stop }, { input, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const result = await read.settle({ rawInput: input, signal: stop });

    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return raise("Cancelled", {});
    return result.value;
  },
});
