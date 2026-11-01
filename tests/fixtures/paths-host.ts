import { serveMain } from "~/base/bun-host";

/**
 * A host that also forwards `/mcp` and `/.well-known/*` to its command. The command answers "cmd"
 * on every path it gets; every other path gets "page". It runs until a signal stops it.
 */
await serveMain(
  async ({ signal }) => ({
    fetch: async () => new Response("cmd"),
    closed: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  }),
  { "/*": new Response("page") },
  { paths: ["/mcp", "/.well-known/*"] },
);
