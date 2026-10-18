import { createMiddleware } from "@tanstack/react-start";
import { extension } from "@tinker/core";
import type { Scope } from "@tinker/core";

import { raise } from "~/components/errors";

import { responseBodies } from "./body.server";
import { requestHeaders } from "./headers.server";
import { backendStop, requestStop } from "./lifetime";
import { requestClose, requestLifetime } from "./lifetime.server";
import { renderLifetime } from "./render-lifetime.server";

/** Start merges this registry to type the context supplied by the server entry. */
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { scope?: Scope.Handle } };
  }
}

/** This root middleware uses only fetch context, before global middleware has run. */
const middleware = createMiddleware().server(async ({ context, request, next }) => {
  if ("session" in context && context.session !== undefined) raise("StartSessionAlreadySet", {});

  const scope = context.scope;
  if (scope === undefined) raise("StartScopeMissing", {});

  const session = scope.createSession({
    tags: [
      requestHeaders(new Headers(request.headers)),
      requestStop(request.signal),
      requestClose((graceful) => session.close({ graceful })),
    ],
  });
  session.resolve(renderLifetime).open(request);

  const lifetime = session.resolve(requestLifetime);

  try {
    const result = await next({ context: { session, signal: request.signal } });
    return {
      ...result,
      response: await (
        await session.resolve(responseBodies)
      ).hold(result.response, lifetime.finish),
    };
  } catch (error) {
    await lifetime.finish(false);
    throw error;
  }
});

/** Startup supplies the root context; all Start boundaries share this middleware. */
export const startRequests = Object.assign(
  extension({
    label: "start.requests",
    hooks: {
      async start(event) {
        event.resolve(backendStop);
        await event.next();
        return { scope: event.scope };
      },
    },
  }),
  { middleware },
);
