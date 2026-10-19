import { resource, tag } from "@tinker/core";
import type { Scope } from "@tinker/core";

import { hostResponses } from "./body.server";
import { renderFrames } from "./render-lifetime.server";

/** The native middleware lends its session close to that session. */
export const requestClose = tag<(graceful: boolean) => Promise<Scope.Result>>({
  label: "request.closeOwner",
});

/**
 * One session resource per request: it shares one close promise without joining the
 * session's own teardown, and retains the request's render close until that teardown.
 */
export const requestLifetime = resource({
  label: "request.close",
  target: "session",
  depends: { close: requestClose.required, renders: renderFrames, responses: hostResponses },
  factory: ({ close, renders, responses }, ctx) => {
    let closed: Promise<void> | undefined;
    let owned: { close: (() => Promise<void>) | undefined } | undefined;
    let request: Request | undefined;
    ctx.defer(() => {
      if (request) renders.release(request);
      request = undefined;
      const render = owned?.close;
      if (owned) owned.close = undefined;
      return render?.();
    });

    const lifetime = {
      finish: (graceful: boolean) => {
        return (closed ??= Promise.resolve(close(graceful)).then((end) => {
          if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
        }));
      },
      open(value: Request) {
        request = value;
        owned = renders.open(value);
      },
      /** The host's response close ends the request, with no body rewrap; false without a host. */
      endOnHostClose(hosted: Request) {
        const outgoing = responses.isHosted(hosted) ? hosted.runtime.node?.res : undefined;
        if (outgoing === undefined) return false;

        responses.endOnClose(outgoing, lifetime.finish);
        return true;
      },
    };
    return lifetime;
  },
});
