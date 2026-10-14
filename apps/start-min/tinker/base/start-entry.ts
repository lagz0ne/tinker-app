import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";

/** The command passes app options; CSRF and requests run before its middleware. */
export function createStartEntry(app: { getOptions: Parameters<typeof createStart>[0] }) {
  const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });
  let options: ReturnType<typeof readOptions> | undefined;

  async function readOptions() {
    const own = await app.getOptions();
    return {
      ...own,
      requestMiddleware: [csrf, startRequests.middleware, ...(own.requestMiddleware ?? [])],
    };
  }

  return createStart(() => (options ??= readOptions()));
}
