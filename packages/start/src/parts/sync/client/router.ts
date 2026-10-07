import { resource } from "@tinker/core";
import { readSnapshot } from "#tinker/app";
import type { SyncPart } from "../part";
import { checkAccount, loadSnapshot, syncStreaming } from "./events";
import { tabLifetime } from "./owner";
import { applyBootstrap, syncClient } from "./sync";

/**
 * The router side of sync: the server render loads the snapshot and dehydrates it; the tab
 * hydrates it, then starts streaming. A real page hide closes the tab's app root.
 */
export const syncRouter = resource({
  label: "sync.router",
  depends: {
    sync: syncClient,
    load: loadSnapshot.controller,
    check: checkAccount.controller,
    apply: applyBootstrap.controller,
    streaming: syncStreaming,
    lifetime: tabLifetime,
  },
  factory: async ({ sync, load, check, apply, streaming, lifetime }) => {
    const options: SyncPart.Options = {
      context: { bootstrap: () => load.run(), account: () => check.run() },
      dehydrate: () => sync.snapshot(),
      hydrate: async (raw) => {
        const snapshot = readSnapshot.parse(raw);
        await apply.run({ input: { snapshot, version: sync.capture().version } });
        streaming.start();
      },
    };
    return { options, bind: lifetime.bind };
  },
});
