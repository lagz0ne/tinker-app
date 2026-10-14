import { createStartHandler as createStart } from "@tanstack/react-start/server";
import { defaultStreamHandler as renderStream } from "@tanstack/react-start/server";

import initialApp from "#tinker/server";

import { retainRender } from "../backend/render-lifetime.server";
import { raise } from "../errors";
import { devErrorPage } from "./dev-error";
import type { getRouter } from "./router";

let app = initialApp;

if (import.meta.hot) {
  import.meta.hot.accept("#tinker/server", async () => {
    app = (await import("#tinker/server")).default;
  });
  import.meta.hot.on("vite:beforeFullReload", close);
}

const renderRequest = createStart(async (context) => {
  const router: typeof context.router & {
    close?: Awaited<ReturnType<typeof getRouter>>["close"];
  } = context.router;
  if (typeof router.close !== "function") raise("StartScopeMissing", {});
  retainRender(context.request, router.close);
  try {
    return await renderStream(context);
  } catch (error) {
    await router.close();
    throw error;
  }
});

const entry = {
  fetch(request: Request) {
    const next = async (forwarded: Request) => {
      const response = await renderRequest(forwarded, { context: app.requestContext });
      return import.meta.env.DEV ? devErrorPage(forwarded, response) : response;
    };
    return app.fetch ? app.fetch(request, next) : next(request);
  },
};

export default entry;

export function close() {
  return app.close();
}

/** Server renders borrow observation; the app entry owns its telemetry root. */
export function getRenderObserver() {
  return app.renderObserve;
}
