import { operation } from "@tinker/core";
import { z } from "zod";

import type { Errors } from "@/demo/errors";

/** A settled write, as the server function's `settle` returns it. */
const settledWrite = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), value: z.object({ executionId: z.string() }) }),
  z.object({ status: z.literal("failed"), error: z.unknown() }),
  z.object({ status: z.literal("cancelled"), reason: z.unknown() }),
]);

/** A refused input shows its own reason. */
const badInput = z.object({
  kind: z.literal("BadInput"),
  payload: z.object({ reason: z.string() }),
});

/** Any other managed failure, read by its kind. */
const managed = z.object({ kind: z.string() });

/** The refusals a browser shows, by kind; any other failure stays the server's error. */
const rejections: Partial<Record<string, string>> = {
  SignInRequired: "Sign in to change private records.",
  TodoMissing: "That todo is not in your list.",
  RetryNotAvailable: "There is no failed notification to retry.",
  StreamDenied: "That execution is not in your stream.",
};

/** One settled write becomes its network receipt: accepted, a shown refusal, or its own failure. */
export const readReceipt = operation({
  label: "transport.receipt",
  input: settledWrite,
  run: (_deps, { input, raise }) => {
    if (input.status === "success") {
      return { kind: "accepted" as const, executionId: input.value.executionId };
    }

    if (input.status === "cancelled") {
      return raise("Cancelled", {} satisfies Errors.Payload<"Cancelled">);
    }

    const refused = badInput.safeParse(input.error);
    if (refused.success) return { kind: "rejected" as const, message: refused.data.payload.reason };

    const kind = managed.safeParse(input.error);
    const message =
      kind.success && Object.hasOwn(rejections, kind.data.kind)
        ? rejections[kind.data.kind]
        : undefined;
    if (message !== undefined) return { kind: "rejected" as const, message };

    throw input.error;
  },
});
