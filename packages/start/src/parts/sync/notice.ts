/** The text every account notice starts with, built once from `accountNotice`. */
const accountPrefix = accountNotice("");

/**
 * The payload an auth path sends on the `start_sync` channel to name one account.
 * @param accountId - From the auth path; why: the account whose streams must re-read.
 */
export function accountNotice(accountId: string) {
  return `account:${accountId}`;
}

/**
 * The account a channel payload names. A table wake names no account, so it gives null.
 * @param payload - From the listener; why: the text the channel sent with a notification.
 */
export function accountOfNotice(payload: string) {
  return payload.startsWith(accountPrefix) ? payload.slice(accountPrefix.length) : null;
}
