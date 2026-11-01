import { serveMain } from "~/base/bun-host";

/**
 * A host whose command exits 64 during start after it built a root: its `closed` resolves only
 * after a short teardown, which prints "closed". The host must wait for it, and never listen.
 */
await serveMain(async ({ exit }) => {
  exit(64);
  const closed = Bun.sleep(100).then(() => console.log("closed"));
  return { fetch: async () => undefined, closed };
}, {});
