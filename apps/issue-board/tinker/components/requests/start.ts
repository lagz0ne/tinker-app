import { createMiddleware } from "@tanstack/react-start";
import { extension } from "@tinker/core";
import type { Scope } from "@tinker/core";

import type { Errors } from "~/components/errors";

import { responseBodies } from "./body.server";
import { requestHeaders } from "./headers.server";
import { backendStop, requestStop } from "./lifetime";
import { requestClose, requestLifetime } from "./lifetime.server";

/** Start merges this registry to type the context supplied by the server entry. */
declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { scope?: Scope.Handle } };
  }
}

/** This root middleware uses only fetch context, before global middleware has run. */
// No Core ctx or scope reaches these two checks, so each builds the managed error Core's raise makes.
const middleware = createMiddleware().server(async ({ context, request, next }) => {
  if ("session" in context && context.session !== undefined) {
    throw Object.assign(new Error("StartSessionAlreadySet"), {
      kind: "StartSessionAlreadySet",
      payload: {} satisfies Errors.Payloads["StartSessionAlreadySet"],
    });
  }

  const scope = context.scope;
  if (scope === undefined) {
    throw Object.assign(new Error("StartScopeMissing"), {
      kind: "StartScopeMissing",
      payload: {} satisfies Errors.Payloads["StartScopeMissing"],
    });
  }

  const session = scope.createSession({
    tags: [
      requestHeaders(request.headers),
      requestStop(request.signal),
      requestClose((graceful) => session.close({ graceful })),
    ],
  });
  const lifetime = session.resolve(requestLifetime);
  lifetime.open(request);

  try {
    const result = await next({ context: { session, signal: request.signal } });
    if (lifetime.endOnHostClose(request)) return result;

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
