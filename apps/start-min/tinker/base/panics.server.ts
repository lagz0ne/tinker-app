import { inspect } from "node:util";

import type { ServerEntry } from "./server-entry";

/** Report unhandled process work and close the main before exit; this starts no root. */
export function observeServerPanics(entry: ServerEntry.Handle): void {
  const fail = async (error: unknown) => {
    process.stderr.write(`server: unhandled rejection ${inspect(error)}\n`);
    try {
      await entry.close();
    } finally {
      process.exit(1);
    }
  };

  process.on("unhandledRejection", fail);
  entry.requestContext.scope.onClose(() => {
    process.off("unhandledRejection", fail);
  });
}
