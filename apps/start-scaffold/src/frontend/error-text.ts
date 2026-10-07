import { isError } from "../errors";
/**
 * @param error - From a form action failure; why: pick the shown message.
 */
export function errorText(error: unknown) {
  if (isError(error, "AuthFailed")) return error.payload.message;
  if (isError(error, "WriteRejected")) return error.payload.message;
  if (isError(error, "BadInput")) return error.payload.reason;
  return error ? "That did not work. Try again." : "";
}
