import { resource } from "@tinker/core";

import type { Errors } from "~/components/errors";

/** The app owns the lookup; each request session owns its render close (`requestLifetime`). */
export const renderFrames = resource({
  label: "request.renders",
  target: "scope",
  factory: (_deps, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const renders = new WeakMap<Request, { close: (() => Promise<void>) | undefined }>();

    return {
      open(request: Request) {
        const owned = { close: undefined as (() => Promise<void>) | undefined };
        renders.set(request, owned);
        return owned;
      },
      release(request: Request) {
        renders.delete(request);
      },
      /** A render with no router close, or with no open request, has no Start scope; a retained render gets its close back. */
      retain(request: Request, close: (() => Promise<void>) | undefined) {
        if (typeof close !== "function") {
          return raise("StartScopeMissing", {});
        }

        const owned = renders.get(request);
        if (owned === undefined) {
          return raise("StartScopeMissing", {});
        }
        owned.close = close;
        return close;
      },
    };
  },
});
