import { inspect } from "node:util";

/** Report unhandled work, close through the caller, then leave with failure. */
export function observeServerPanics(
  abort: () => void,
  closed: Promise<void>,
  stderr: { write(chunk: string): unknown },
): () => void {
  const fail = async (error: unknown) => {
    stderr.write(`server: unhandled rejection ${inspect(error)}\n`);
    try {
      abort();
      await closed;
    } finally {
      process.exit(1);
    }
  };
  process.on("unhandledRejection", fail);
  return process.off.bind(process, "unhandledRejection", fail);
}
