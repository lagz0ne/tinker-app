import { syncStreaming } from "~/components/sync/client/events";
import { accountOwner } from "~/components/sync/client/owner";
import { syncRouter } from "~/components/sync/client/router";
import { tabStop } from "~/components/sync/client/tab";
import type { SyncPart } from "~/components/sync/part";
import { syncRecords } from "~/components/sync/slots";

/** The command supplies slots; the copied component owns its tab lifetime and state. */
export const sync: SyncPart.Router<SyncPart.Options> = {
  extensions: [syncRecords, accountOwner, syncStreaming],
  router: syncRouter,
  stop: tabStop,
};

export * from "~/components/sync/envelopes";

export {
  recordsSlot,
  readBatchSlot,
  readBootstrapSlot,
  readSnapshotSlot,
  streamMessageSlot,
} from "~/components/sync/slots";

export {
  syncClient,
  applyBootstrap,
  applyEvents,
  leaveAccount,
} from "~/components/sync/client/sync";

export { snapshotLoader, loadSnapshot, checkAccount } from "~/components/sync/client/events";
export { tabStop } from "~/components/sync/client/tab";
