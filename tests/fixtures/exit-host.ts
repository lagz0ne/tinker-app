import { serveMain } from "~/base/bun-host";

/** A host whose command exits 64 during start, as `cmds/server.ts` does on extra args. */
await serveMain(async ({ exit }) => {
  exit(64);
  return { fetch: async () => undefined, closed: Promise.resolve() };
}, {});
