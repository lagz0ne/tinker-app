import { createScope, extension } from "@tinker/core";
import { authSettings, databaseSettings, mailSettings, migrate } from "@/lib/tinker.server";
import {
  history,
  observer,
  telemetry,
  telemetrySettings,
  ingestTelemetry,
} from "../telemetry/index.ts";
import { startRequests } from "../start.ts";
import { browserTelemetry, telemetryOrigin } from "../telemetry/ingest.server.ts";
import { readSettings } from "./settings.server.ts";
import { backendStop } from "./lifetime.ts";
const setup = extension({
  label: "backend.setup",
  hooks: {
    async start(event) {
      await event.next();
      await event.scope.run(migrate);
    },
  },
});
let owned: ReturnType<typeof start> | undefined;
/** This framework entry retains one process root; importing it starts no clients. */
async function start() {
  const settings = readSettings(process.env);
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
    (closed ??= (async () => {
      stop.abort();
      const end = await app.closed;
      toolStop.abort();
      const toolEnd = await tools.closed;
      if (end.status === "failed") throw end.error;
      if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
      if (toolEnd.status === "failed") throw toolEnd.error;
      if (toolEnd.teardownErrors?.length) throw toolEnd.teardownErrors.at(0);
    })());
  if (import.meta.hot) import.meta.hot.dispose(close);
  return {
    requestContext: app.resolve(startRequests),
    close,
    readHistory: () => tools.resolve(history),
  };
}
export function getBackend() {
  return (owned ??= start());
}
export async function closeBackend() {
  if (owned) await (await owned).close();
}
