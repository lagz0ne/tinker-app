import { serveMain } from "~/base/bun-host";

/**
 * A host with no extra paths. The command answers "cmd" on every path it gets; every other path
 * gets "page". It runs until a signal stops it; its root prints "closed" when it closes.
 */
await serveMain(
  async ({ signal }) => ({
    fetch: async () => new Response("cmd"),
    closed: new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => {
        console.log("closed");
        resolve();
      }),
    ),
  }),
  { "/*": new Response("page") },
);
