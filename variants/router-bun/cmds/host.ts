import { serveMain } from "~/base/bun-host";

import main from "./server";

/**
 * The built server. The client build sits beside it in `dist/client`. Only the files that build
 * made are served, by name (hashed, cached for a year); nothing from a request reaches the disk.
 * Any other path gets `index.html`: the router owns it.
 */
const client = new URL("../client/", import.meta.url);
const immutable = { "Cache-Control": "public, max-age=31536000, immutable" };

const files = [...new Bun.Glob("*").scanSync(Bun.fileURLToPath(client))]
  .filter((name) => name !== "index.html")
  .map((name) => [
    `/${name}`,
    new Response(Bun.file(new URL(name, client)), { headers: immutable }),
  ]);

await serveMain(main, {
  ...Object.fromEntries(files),
  "/*": new Response(Bun.file(new URL("index.html", client)), {
    headers: { "Cache-Control": "no-cache" },
  }),
});
