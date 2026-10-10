/** The text that starts a sync channel payload which names one account. */
const accountPrefix = "account:";

/**
 * The payload an auth path sends on the `start_sync` channel to name one account.
 * @param accountId - From the auth path; why: the account whose streams must re-read.
 */
export const accountNotice = (accountId: string) => `${accountPrefix}${accountId}`;

/**
 * The account a channel payload names. A table wake names no account, so it gives null.
 * @param payload - From the listener; why: the text the channel sent with a notification.
 */
export const accountOfNotice = (payload: string) =>
  payload.startsWith(accountPrefix) ? payload.slice(accountPrefix.length) : null;
