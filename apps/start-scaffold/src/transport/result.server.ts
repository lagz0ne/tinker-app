import type { RunResult } from "@tinker/core";
import { isError, raise } from "../errors";

/**
 * @param result - From a settled mutation; why: turn its result into a network receipt.
 */
export function readReceipt(result: RunResult<{ executionId: string }>) {
  if (result.status === "success")
    return { kind: "accepted" as const, executionId: result.value.executionId };
  if (result.status === "cancelled") raise("Cancelled", {});
  const error = result.error;
  if (isError(error, "BadInput"))
    return { kind: "rejected" as const, message: error.payload.reason };
  if (isError(error, "SignInRequired"))
    return { kind: "rejected" as const, message: "Sign in to change private records." };
  if (isError(error, "TodoMissing"))
    return { kind: "rejected" as const, message: "That todo is not in your list." };
  if (isError(error, "RetryNotAvailable"))
    return { kind: "rejected" as const, message: "There is no failed notification to retry." };
  if (isError(error, "StreamDenied"))
    return { kind: "rejected" as const, message: "That execution is not in your stream." };
  throw error;
}
