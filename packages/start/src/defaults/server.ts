import { createServerEntry } from "../server-entry.ts";
/** The base's default server file: an app with no src/server.ts goes straight to the base. */
export default createServerEntry({ fetch: (request, next) => next(request) });
