import { serve } from "@tinker/bun";

import main from "./server";

/** Dev: the server half alone. `vp dev` serves the page and proxies /rpc and /api here. */
await serve(main, {});
