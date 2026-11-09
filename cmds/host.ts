import { serve } from "@tinker/bun";

import page from "./index.html";
import main from "./server";

/**
 * The server, in dev and built. Dev: `bun --hot` bundles the page on request. Built:
 * `bun build --compile` bundles the page from this HTML import and puts its files inside the
 * one binary, with the server as bytecode; nothing is read from disk at run time.
 */
await serve(main, { "/*": page });
