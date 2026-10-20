import { resource } from "@tinker/core";

import { raise } from "~/components/errors";

/** The app owns the lookup; each request session owns its render close (`requestLifetime`). */
export const renderFrames = resource({
  label: "request.renders",
  target: "scope",
  factory: () => {
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
      retain(request: Request, close: () => Promise<void>) {
        const owned = renders.get(request);
        if (owned === undefined) raise("StartScopeMissing", {});
        owned.close = close;
      },
    };
  },
});
