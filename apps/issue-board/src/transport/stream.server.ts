import { operation } from "@tinker/core";
import { z } from "zod";

import { openSync } from "~/components/auth/index.server";
import type { Errors } from "~/components/errors";

/** The request event stream; the request stop owns its body, so it takes no call signal. */
export const streamOpen = operation({
  label: "transport.stream",
  input: z.unknown(),
  depends: { read: openSync.controller },
  run: async ({ read }, { input, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const result = await read.settle({ rawInput: input });

    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return raise("Cancelled", {});
    return result.value;
  },
});
