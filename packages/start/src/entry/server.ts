import { createScope } from "@tinker/core";
import { createStartHandler as createStart } from "@tanstack/react-start/server";
import { defaultStreamHandler as renderStream } from "@tanstack/react-start/server";
import { extensions } from "#tinker/app.server";
import { auth, telemetry } from "#tinker/parts.server";
import app from "#tinker/server";
import type { getRouter } from "./router";
import { responseBodies } from "../backend/body.server";
import { devErrorPage } from "./dev-error";
import { backendStop } from "../backend/lifetime";
import { env } from "../env";
import { raise } from "../errors";
import { startRequests } from "../start";

const renderRequest = createStart(async (context) => {
  const { requestContext } = await (entry.owned ??= start());
  const bodies = requestContext.scope.resolve(responseBodies);
  const router: typeof context.router & {
    close?: Awaited<ReturnType<typeof getRouter>>["close"];
  } = context.router;
  if (typeof router.close !== "function") raise("StartScopeMissing", {});
  try {
    const output = await renderStream(context);
    if (bodies.isResponse(output)) return bodies.hold(output, router.close);
    return { ...output, response: await bodies.hold(output.response, router.close) };
  } catch (error) {
    await router.close();
    throw error;
  }
});

/**
 * The base's server entry owns the process roots and their stop signals (ADR 0100). The
 * telemetry root observes the app root, so its own sends are never traced; it closes last.
 */
async function start() {
  const settings = env({ ...process.env });
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: telemetry.extensions,
    tags: [settings, telemetry.tags],
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    observe: tools.resolve(telemetry.observe),
    extensions: [startRequests, auth.extensions, extensions],
    tags: [backendStop(stop.signal), settings, tools.resolve(telemetry.appTags)],
  });
  try {
    await app.ready;
  } catch (error) {
    toolStop.abort();
    await tools.closed;
    throw error;
  }
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= Promise.resolve().then(async () => {
      stop.abort();
      const end = await app.closed;
      toolStop.abort();
      const toolEnd = await tools.closed;
      if (end.status === "failed") throw end.error;
      if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
      if (toolEnd.status === "failed") throw toolEnd.error;
      if (toolEnd.teardownErrors?.length) throw toolEnd.teardownErrors.at(0);
    }));
  if (import.meta.hot) import.meta.hot.dispose(close);
  return {
    requestContext: app.resolve(startRequests),
    renderObserve: tools.resolve(telemetry.renderObserve, { ns: telemetry.renderNs }),
    close,
  };
}

const entry: {
  owned?: ReturnType<typeof start>;
  fetch(request: Request): Promise<Response>;
} = {
  /** src/server.ts runs first; its `next` reaches the base's handler. */
  async fetch(request: Request) {
    return app.fetch(request, async (forwarded) => {
      const { requestContext } = await (entry.owned ??= start());
      const response = await renderRequest(forwarded, { context: requestContext });
      return import.meta.env.DEV ? devErrorPage(forwarded, response) : response;
    });
  },
};
export default entry;
export async function close() {
  if (entry.owned) await (await entry.owned).close();
}

/** Server renders borrow observation; only process close ends its telemetry root. */
export async function getRenderObserver() {
  return (await (entry.owned ??= start())).renderObserve;
}
