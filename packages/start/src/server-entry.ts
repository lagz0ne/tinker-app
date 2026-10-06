/** What src/server.ts, a named file (ADR 0106), exports by default. */
export declare namespace ServerEntry {
  /** The base's request handler, passed to src/server.ts as `next`. */
  type Next = (request: Request) => Promise<Response>;
  type Handle = {
    fetch(request: Request, next: Next): Promise<Response> | Response;
  };
}

/**
 * src/server.ts wraps the base's handler with this; Start's own server-entry would skip the
 * base's scope (ADR 0100).
 * @param entry - From src/server.ts; why: the app's own step before and after the base.
 */
export function createServerEntry(entry: ServerEntry.Handle): ServerEntry.Handle {
  return entry;
}
