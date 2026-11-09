import { serve } from "@tinker/bun";

import files from "./client-files.gen";
import main from "./server";

/** Hashed assets never change; the page itself is read fresh. */
const immutable = { "cache-control": "public, max-age=31536000, immutable" };

/** Each client file the build put inside the binary, as a static route. */
const pages: Record<string, Response> = {};

for (const [path, file] of Object.entries(files)) {
  pages[path] = new Response(
    Bun.file(file),
    path.startsWith("/assets/") ? { headers: immutable } : {},
  );
}

const index = files["/index.html"];

/**
 * Built: `vp build` made the client, `bun build --compile` put it inside the one binary beside
 * the server, as bytecode. Every path the command does not take gets the page (a deep link).
 */
await serve(main, index ? { ...pages, "/*": new Response(Bun.file(index)) } : pages);
