import { createMiddleware } from "@tanstack/react-start";
import { extension, operation } from "@tinker/core";
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

/** A request that already carries a session went through this middleware twice. */
const sessionTaken = operation({
  label: "request.sessionTaken",
  run: (_deps, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    return raise("StartSessionAlreadySet", {});
  },
});

/** This root middleware uses only fetch context, before global middleware has run. */
const middleware = createMiddleware().server(async ({ context, request, next }) => {
  const scope = context.scope;
  // No scope means no Core ctx and nothing to run on, so this one check builds the managed
  // error Core's raise makes.
  if (scope === undefined) {
    throw Object.assign(new Error("StartScopeMissing"), {
      kind: "StartScopeMissing",
      payload: {} satisfies Errors.Payloads["StartScopeMissing"],
    });
  }

  if ("session" in context && context.session !== undefined) scope.run(sessionTaken);

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
