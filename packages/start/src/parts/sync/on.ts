import { accountOwner } from "./client/owner";
import { syncStreaming } from "./client/events";
import { syncRouter } from "./client/router";
import type { SyncPart } from "./part";

/** The sync part, on, for the router entry: the tab's account owner, stream, and router options. */
export const sync: SyncPart.Router<SyncPart.Options> = {
  extensions: [accountOwner, syncStreaming],
  router: syncRouter,
};
