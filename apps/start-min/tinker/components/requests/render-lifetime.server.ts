import { resource } from "@tinker/core";

import { raise } from "~/components/errors";

/** The app owns the lookup; each request session owns its render close. */
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

/** The request retains render work until its body ends. */
export const renderLifetime = resource({
  label: "request.renderLifetime",
  target: "session",
  depends: { renders: renderFrames },
  factory: ({ renders }, ctx) => {
    let owned: { close: (() => Promise<void>) | undefined } | undefined;
    let request: Request | undefined;
    ctx.defer(() => {
      if (request) renders.release(request);
      request = undefined;
      const close = owned?.close;
      if (owned) owned.close = undefined;
      return close?.();
    });

    return {
      open(value: Request) {
        request = value;
        owned = renders.open(value);
      },
    };
  },
});
