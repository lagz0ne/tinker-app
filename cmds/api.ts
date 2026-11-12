import { run } from "@tinkered/bun";

import main from "./server";

/** Dev: the server half alone. `vp dev` serves the page and proxies /rpc and /api here. */
await run(main);
