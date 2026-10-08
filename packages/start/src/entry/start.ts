import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { startInstance as app } from "#tinker/start";
import { startRequests } from "../start";

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });
let options: ReturnType<typeof readOptions> | undefined;

/** Start options are process settings; each request borrows the same middleware list. */
async function readOptions() {
  const own = await app.getOptions();
  return {
    ...own,
    requestMiddleware: [csrf, startRequests.middleware, ...(own.requestMiddleware ?? [])],
  };
}

/** The base's middleware runs first; src/start.ts, a named file (ADR 0106), adds the rest. */
export const startInstance = createStart(() => (options ??= readOptions()));
