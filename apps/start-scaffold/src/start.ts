import { createStart, createCsrfMiddleware } from "@tanstack/react-start";
import { startRequests } from "./scaffold/start.ts";
export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    startRequests.middleware,
  ],
}));
