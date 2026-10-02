import type { RunResult } from "@tinker/core";
import { isError, raise } from "../../errors.ts";
/** HTTP boundaries handle a settled failure without failing the server root. */
export function readResult<T>(result: RunResult<T>): T {
  if (result.status === "failed") throw result.error;
  if (result.status === "cancelled") raise("Cancelled", {});
  return result.value;
}
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
