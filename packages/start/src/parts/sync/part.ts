import type { Many, Resource, Scope } from "@tinker/core";
import type { Sync } from "./envelopes.ts";

/**
 * The shape of the sync part for the router entry, in a file that imports no seam name, so an
 * app with sync off type-checks its off module without them.
 */
export declare namespace SyncPart {
  /** What the router entry spreads into its router options while sync is on. */
  type Options = {
    context: Sync.RouterContext;
    dehydrate: () => Sync.Snapshot;
    hydrate: (raw: unknown) => Promise<void>;
  };
  /** What a part gives the router entry: app root extensions, and a resource read from it. */
  type Router<O> = {
    readonly extensions: Many<Scope.Extension<unknown>>;
    readonly router: Resource.Handle<
      Promise<{ options: O; bind(close: () => Promise<void>): void }>
    >;
  };
}
