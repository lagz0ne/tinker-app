import { createMiddleware } from "@tanstack/react-start";
import { extension } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { requestHeaders } from "../backend/index.ts";
import { raise } from "../errors.ts";
import { holdResponse } from "./backend/body.server.ts";
import { requestStop } from "./backend/lifetime.ts";

/** Start merges this registry to type the context supplied by the server entry. */
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { scope?: Scope.Handle } };
  }
}

/** This root middleware uses only fetch context, before global middleware has run. */
const middleware = createMiddleware().server(async ({ context, request, next }) => {
  const scope = context.scope;
  if (scope === undefined) raise("StartScopeMissing", {});
  const session = scope.createSession({
    tags: [requestHeaders(new Headers(request.headers)), requestStop(request.signal)],
  });
  let closed: Promise<void> | undefined;
  const finish = (graceful: boolean) =>
    (closed ??= session.close({ graceful }).then((end) => {
      if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
    }));
  try {
    const result = await next({ context: { session, signal: request.signal } });
    return { ...result, response: await holdResponse(result.response, finish) };
  } catch (error) {
    await finish(false);
    throw error;
  }
});

/** Startup supplies the native fetch binding; all Start boundaries share this middleware. */
export const startRequests = Object.assign(
  extension({
    label: "start.requests",
    hooks: {
      async start(event) {
        await event.next();
        return { scope: event.scope };
      },
    },
  }),
  { middleware },
);
