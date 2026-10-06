import { accountOwner } from "./client/owner.ts";
import { syncStreaming } from "./client/events.ts";
import { syncRouter } from "./client/router.ts";
import type { SyncPart } from "./part.ts";

/** The sync part, on, for the router entry: the tab's account owner, stream, and router options. */
export const sync: SyncPart.Router<SyncPart.Options> = {
  extensions: [accountOwner, syncStreaming],
  router: syncRouter,
};
