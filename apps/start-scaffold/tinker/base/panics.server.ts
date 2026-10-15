import { inspect } from "node:util";

/** Report unhandled work, close through the caller, then leave with failure. */
export function observeServerPanics(close: () => Promise<void>): () => void {
  const fail = async (error: unknown) => {
    process.stderr.write(`server: unhandled rejection ${inspect(error)}\n`);
    try {
      await close();
    } finally {
      process.exit(1);
    }
  };
  process.on("unhandledRejection", fail);
  return process.off.bind(process, "unhandledRejection", fail);
}
