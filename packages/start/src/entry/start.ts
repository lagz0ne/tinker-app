import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { startInstance as app } from "#tinker/start";
import { startRequests } from "../start";

/** The base's middleware runs first; src/start.ts, a named file (ADR 0106), adds the rest. */
export const startInstance = createStart(async () => {
  const own = await app.getOptions();
  return {
    ...own,
    requestMiddleware: [
      createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
      startRequests.middleware,
      ...(own.requestMiddleware ?? []),
    ],
  };
});
