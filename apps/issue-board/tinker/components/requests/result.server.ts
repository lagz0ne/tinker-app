import { operation } from "@tinker/core";

import type { Errors } from "~/components/errors";

/**
 * A boundary's settled call that was cancelled ends as the base's `Cancelled` error. The boundary
 * throws a settled failure as is, so a failed call never fails the server root.
 */
export const cancelledCall = operation({
  label: "request.cancelled",
  run: (_deps, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    return raise("Cancelled", {});
  },
});
