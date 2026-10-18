import { resource, tag } from "@tinker/core";
import type { Scope } from "@tinker/core";

/** The native middleware lends its session close to that session. */
export const requestClose = tag<(graceful: boolean) => Promise<Scope.Result>>({
  label: "request.closeOwner",
});

/** Share one close promise without joining the session's own teardown. */
export const requestLifetime = resource({
  label: "request.close",
  target: "session",
  depends: { close: requestClose.required },
  factory: ({ close }) => {
    let closed: Promise<void> | undefined;

    return {
      finish: (graceful: boolean) => {
        return (closed ??= Promise.resolve(close(graceful)).then((end) => {
          if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
        }));
      },
    };
  },
});
