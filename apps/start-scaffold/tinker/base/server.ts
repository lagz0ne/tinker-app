import { tag } from "@tinker/core";
import type { Scope } from "@tinker/core";
import type { ServerEntry } from "@tinker/start/server";

/** The main supplies its original host signal, before graceful drain joins held requests. */
export const backendStop = tag<AbortSignal>({ label: "lifetime.backendStop" });
const closedReason = { kind: "server.closed" };

/** Unhandled process work is reported and closes the main before exit; no scope starts here. */
export function createServerEntry(entry: ServerEntry.Handle): ServerEntry.Handle {
  const fail = async (error: unknown) => {
    process.stderr.write(`server: unhandled rejection ${String(error)}\n`);
    try {
      await entry.close();
    } finally {
      process.exit(1);
    }
  };

  process.on("unhandledRejection", fail);
  entry.requestContext.scope.onClose(() => {
    process.off("unhandledRejection", fail);
  });
  return entry;
}

/** The main retains named roots in start order and stop controllers with the same names; repeated close calls share one promise. */
export function createScopeClose<T extends Record<string, Scope.RootHandle>>(
  roots: T,
  stop: Record<keyof T, AbortController>,
): () => Promise<void> {
  let closed: Promise<void> | undefined;
  return () => (closed ??= closeRoots(roots, stop));
}

async function closeRoots(
  roots: Record<string, Scope.RootHandle>,
  stop: Record<string, AbortController>,
): Promise<void> {
  const results: Scope.Result[] = [];
  for (const [name, scope] of Object.entries(roots).toReversed()) {
    stop[name].abort(closedReason);
    results.push(await scope.closed);
  }

  for (const result of results) {
    if (result.status === "failed") throw result.error;
    if (result.teardownErrors?.length) throw result.teardownErrors.at(0);
  }
}
