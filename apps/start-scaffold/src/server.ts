import { createScope } from "@tinker/core";
import { authSettings, databaseSettings, mailSettings } from "@/lib/tinker.server";
import {
  history,
  observer,
  telemetry,
  telemetrySettings,
  ingestTelemetry,
} from "./scaffold/telemetry/index.ts";
import { startRequests } from "./scaffold/start.ts";
import { browserTelemetry, telemetryOrigin } from "./scaffold/telemetry/ingest.server.ts";
import { readSettings } from "./scaffold/backend/settings.server.ts";
import { backendStop } from "./scaffold/backend/lifetime.ts";
import { createStartHandler as createStartFetch } from "@tanstack/react-start/server";
import { defaultStreamHandler as renderStartStream } from "@tanstack/react-start/server";
import type { getRouter } from "./router.tsx";
import { responseBodies } from "./scaffold/backend/body.server.ts";
import { setup } from "./scaffold/backend/entry.server.ts";
import { raise } from "./scaffold/errors.ts";
const renderRequest = createStartFetch(async (context) => {
  const { requestContext } = await (entry.owned ??= start());
  const bodies = requestContext.scope.resolve(responseBodies);
  const router: typeof context.router & {
    close?: Awaited<ReturnType<typeof getRouter>>["close"];
  } = context.router;
  if (typeof router.close !== "function") raise("StartScopeMissing", {});
  try {
    const output = await renderStartStream(context);
    if (bodies.isResponse(output)) return bodies.hold(output, router.close);
    return { ...output, response: await bodies.hold(output.response, router.close) };
  } catch (error) {
    await router.close();
    throw error;
  }
});
/** The Start entry owns the process roots and their stop signals. */
async function start() {
  const settings = readSettings({ ...process.env });
  const { tanstackStartCookies } = await import("better-auth/tanstack-start");
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: [telemetry],
    tags: telemetrySettings(settings.telemetry),
  });
  await tools.ready;
  const ingest = tools.controller(ingestTelemetry);
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    observe: await tools.resolve(observer),
    extensions: [setup, startRequests],
    tags: [
      backendStop(stop.signal),
      telemetryOrigin(settings.origin),
      browserTelemetry(async (batch) => {
        await Promise.resolve(
          ingest.run({
            input: {
              traces: batch.traces,
              logs: batch.logs.map((record) => ({
                ...record,
                service: settings.telemetry.service,
              })),
            },
          }),
        );
      }),
      databaseSettings(settings.database),
      mailSettings(settings.mail),
      authSettings({
        origin: settings.origin,
        secret: settings.secret,
        plugins: [tanstackStartCookies()],
      }),
    ],
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
    close,
    readHistory: () => tools.resolve(history),
  };
}

const entry: {
  owned?: ReturnType<typeof start>;
  fetch(request: Request): ReturnType<typeof renderRequest>;
} = {
  async fetch(request: Request) {
    const { requestContext } = await (entry.owned ??= start());
    return renderRequest(request, { context: requestContext });
  },
};
export default entry;
export async function close() {
  if (entry.owned) await (await entry.owned).close();
}
