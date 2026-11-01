import { serveMain } from "~/base/bun-host";

import page from "./index.html";
import main from "./server";

/** Dev: Bun bundles the page on request. */
await serveMain(main, { "/*": page });
