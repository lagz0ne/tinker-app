import { resource } from "@tinker/core";

import { checkAccount, loadSnapshot, syncStreaming } from "~/components/sync-sqlite/client/events";
import { applyBootstrap, syncClient } from "~/components/sync-sqlite/client/sync";
import type { SyncPart } from "~/components/sync-sqlite/part";
import { readSnapshotSlot } from "~/components/sync-sqlite/slots";

/**
 * The router side of sync: the server render loads the snapshot and dehydrates it; the tab
 * hydrates it, then starts streaming. A real page hide closes the tab's app root.
 */
export const syncRouter = resource({
  label: "sync.router",
  depends: {
    sync: syncClient,
    readSnapshot: readSnapshotSlot.required,
    load: loadSnapshot.controller,
    check: checkAccount.controller,
    apply: applyBootstrap.controller,
    streaming: syncStreaming,
  },
  factory: ({ sync, readSnapshot, load, check, apply, streaming }) => {
    const options: SyncPart.Options = {
      context: { bootstrap: load.run.bind(load), account: check.run.bind(check) },
      dehydrate: sync.snapshot,
      hydrate: async (raw) => {
        const snapshot = readSnapshot.parse(raw);
        apply.run({ input: { snapshot, version: sync.version() } });
        streaming.start();
      },
    };
    return options;
  },
});
