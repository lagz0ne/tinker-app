import type { Observe, Scope } from "@tinker/core";

import { abortReasons } from "./errors";

/** The app entry retains both roots; Start borrows context and observation. */
export declare namespace ServerEntry {
  /** Each root keeps its original stop signal. */
  type Root = { scope: Scope.RootHandle; stop: AbortController };
  type Next = (request: Request) => Promise<Response>;
  type Handle = {
    requestContext: { scope: Scope.Handle };
    renderObserve: Observe.Config;
    close(): Promise<void>;
    fetch?(request: Request, next: Next): Promise<Response> | Response;
  };
}

/**
 * Checks the app entry's hand-off without owning or starting any scopes.
 * @param entry - From the app; why: its context, observer, close, and optional request step.
 */
export function createServerEntry(entry: ServerEntry.Handle): ServerEntry.Handle {
  return entry;
}

/**
 * The entry calls this after making roots, in start order. The returned close waits in reverse
 * order and reports the first failure after all roots end. It never creates or starts a scope.
 * @param roots - From the entry; why: the roots and stop controllers it retains until close.
 */
export function createScopeClose(roots: readonly ServerEntry.Root[]): () => Promise<void> {
  let closed: Promise<void> | undefined;
  return () => (closed ??= closeRoots(roots));
}

async function closeRoots(roots: readonly ServerEntry.Root[]): Promise<void> {
  const results: Scope.Result[] = [];
  for (const { scope, stop } of roots.toReversed()) {
    stop.abort(abortReasons.closed);
    results.push(await scope.closed);
  }

  for (const result of results) {
    if (result.status === "failed") throw result.error;
    if (result.teardownErrors?.length) throw result.teardownErrors.at(0);
  }
}
