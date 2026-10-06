import type { RunResult } from "@tinker/core";
import { raise } from "../errors.ts";
/** HTTP boundaries handle a settled failure without failing the server root.
 * @param result - From a settled boundary call; why: return its value or raise its failure.
 */
export function readResult<T>(result: RunResult<T>): T {
  if (result.status === "failed") throw result.error;
  if (result.status === "cancelled") raise("Cancelled", {});
  return result.value;
}
