import { z } from "zod";

import type { Errors } from "@/demo/errors";

/** A failed action that names its own text: an auth or write refusal carries a message. */
const messageFailure = z.object({
  kind: z.enum(["AuthFailed", "WriteRejected"] satisfies readonly Errors.Name[]),
  payload: z.object({ message: z.string() }),
});

/** A refused input carries its reason. */
const reasonFailure = z.object({
  kind: z.literal("BadInput" satisfies Errors.Name),
  payload: z.object({ reason: z.string() }),
});

/** A form's alert: the failure's own message or reason, else a retry hint; empty with no failure. */
export function FailureAlert({ error, className }: { error: unknown; className?: string }) {
  const message = messageFailure.safeParse(error);
  const reason = reasonFailure.safeParse(error);

  return (
    <p role="alert" className={className}>
      {message.data?.payload.message ??
        reason.data?.payload.reason ??
        (error ? "That did not work. Try again." : "")}
    </p>
  );
}
