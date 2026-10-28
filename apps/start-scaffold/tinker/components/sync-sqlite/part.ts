import type { Sync } from "~/components/sync-sqlite/envelopes";

/** The command passes the sync router hooks to Start. */
export declare namespace SyncPart {
  /** The SDK hooks owned by sync; the base never reads their saved state. */
  type Options = {
    context: Sync.RouterContext;
    dehydrate: () => Sync.Snapshot;
    hydrate: (raw: unknown) => Promise<void>;
  };
}
