/**
 * The payload an auth path sends on the `start_sync` channel to name one account.
 * @param accountId - From the auth path; why: the account whose streams must re-read.
 */
export function accountNotice(accountId: string) {
  return `account:${accountId}`;
}
