import { resource } from "@tinker/core";
import { raise } from "../errors";

const renders = new WeakMap<Request, { close: (() => Promise<void>) | undefined }>();

/** The request session retains the render close until its one body ends. */
export const renderLifetime = resource({
  label: "request.renderLifetime",
  target: "session",
  factory: (_deps, ctx) => {
    const owned: { close: (() => Promise<void>) | undefined } = { close: undefined };
    let request: Request | undefined;
    ctx.defer(() => {
      if (request) renders.delete(request);
      request = undefined;
      const close = owned.close;
      owned.close = undefined;
      return close?.();
    });
    return {
      open(value: Request) {
        request = value;
        renders.set(value, owned);
      },
    };
  },
});

/** The render entry transfers close to the already-open request session. */
export function retainRender(request: Request, close: () => Promise<void>) {
  const owned = renders.get(request);
  if (owned === undefined) raise("StartScopeMissing", {});
  owned.close = close;
}
