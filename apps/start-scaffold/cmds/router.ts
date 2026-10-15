import { createScope } from "@tinker/core";

import { once } from "~/base/close";
import {
  createRouterEntry,
  pageEvents,
  readRenderObservation,
  routerScope,
  tabLifetime,
} from "~/base/router-entry";
import type { RouterOptions } from "~/base/router-entry";
import { abortReasons } from "~/components/errors";
import {
  syncStartup,
  syncSide,
  syncRouter,
  tabStop,
  recordsSlot,
  readBatchSlot,
  readBootstrapSlot,
  readSnapshotSlot,
  streamMessageSlot,
} from "~/components/sync";
import {
  telemetryExport,
  telemetrySide,
  telemetryService,
  logConsole,
  observer,
} from "~/components/telemetry";

import { records, readBatch, readBootstrap, readSnapshot, streamMessage } from "@/demo";

const extensions: [] = [];
const router: RouterOptions = {};

/** Start asks for a fresh render root; the browser keeps its root until page hide. */
export async function getRouter() {
  const stop = { tools: new AbortController(), app: new AbortController() };
  const tools = import.meta.env.SSR
    ? undefined
    : createScope({
        signal: stop.tools.signal,
        extensions: [telemetryExport],
        tags: [telemetrySide("browser"), telemetryService("tinker-browser"), logConsole(console)],
      });
  let close = once(async () => {
    stop.tools.abort(abortReasons.closed);
    const result = await tools?.closed;
    if (result?.status === "failed") throw result.error;
    if (result?.teardownErrors?.length) throw result.teardownErrors[0];
  });

  try {
    await tools?.ready;
    const app = createScope({
      signal: stop.app.signal,
      extensions: [routerScope, syncStartup, extensions],
      observe: tools ? tools.resolve(observer) : readRenderObservation(),
      tags: [
        pageEvents(import.meta.env.SSR ? undefined : window),
        syncSide("tab"),
        tabStop(stop.app.signal),
        recordsSlot(records),
        readBatchSlot(readBatch),
        readBootstrapSlot(readBootstrap),
        readSnapshotSlot(readSnapshot),
        streamMessageSlot(streamMessage),
      ],
    });
    close = once(async () => {
      stop.app.abort(abortReasons.closed);
      const appEnd = await app.closed;
      stop.tools.abort(abortReasons.closed);
      const toolsEnd = await tools?.closed;

      for (const result of [appEnd, toolsEnd]) {
        if (result?.status === "failed") throw result.error;
        if (result?.teardownErrors?.length) throw result.teardownErrors[0];
      }
    });

    await app.ready;
    app.resolve(tabLifetime).bind(close);
    if (import.meta.hot) import.meta.hot.dispose(close);
    return await createRouterEntry({
      options: { ...router, ...app.resolve(syncRouter) },
      Wrap: app.resolve(routerScope),
      close,
      dev: import.meta.env.DEV,
      server: import.meta.env.SSR,
    });
  } catch (error) {
    await close().catch((cleanup) => {
      if (cleanup !== error) console.error(cleanup);
    });
    throw error;
  }
}
