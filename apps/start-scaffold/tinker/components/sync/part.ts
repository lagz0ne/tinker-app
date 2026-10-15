import type { Many, Resource, Scope, Tag } from "@tinker/core";

import type { Sync } from "~/components/sync/envelopes";

/** The command passes the copied component's router binding into the base entry. */
export declare namespace SyncPart {
  /** The SDK hooks owned by sync; the base never reads their saved state. */
  type Options = {
    context: Sync.RouterContext;
    dehydrate: () => Sync.Snapshot;
    hydrate: (raw: unknown) => Promise<void>;
  };
  /** What a part gives the router entry: app root extensions, and a resource read from it. */
  type Router<O> = {
    readonly extensions: Many<Scope.Extension<unknown>>;
    readonly router: Resource.Handle<O>;
    readonly stop: Tag.Handle<AbortSignal>;
  };
}
