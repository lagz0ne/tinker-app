import { run } from "@tinkered/bun";

import main from "./server";

/**
 * Built: `vp build` made the client, `bun build --compile` put it inside the one binary beside
 * the server, as bytecode. `run` owns signals and the exit code; `serve` in the root listens.
 */
await run(main);
