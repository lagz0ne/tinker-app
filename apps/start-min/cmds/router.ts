import { createScope } from "@tinker/core";

import {
  createRouterEntry,
  pageEvents,
  readRenderObservation,
  routerScope,
  tabLifetime,
} from "~/base/router-entry";
import { abortReasons } from "~/components/errors";
import {
  telemetryExport,
  telemetrySide,
  telemetryService,
  logConsole,
  observer,
} from "~/components/telemetry";

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

  try {
    await tools?.ready;
    const app = createScope({
      signal: stop.app.signal,
      extensions: [routerScope],
      observe: tools ? tools.resolve(observer) : readRenderObservation(),
      tags: [pageEvents(import.meta.env.SSR ? undefined : window)],
    });
    const closed = app.closed.then(async (appEnd) => {
      stop.tools.abort(abortReasons.closed);
      const toolsEnd = await tools?.closed;

      for (const result of [appEnd, toolsEnd]) {
        if (result?.status === "failed") throw result.error;
        if (result?.teardownErrors?.length) throw result.teardownErrors[0];
      }
    });
    void closed.catch(() => {});
    const close = () => {
      stop.app.abort(abortReasons.closed);
      return closed;
    };

    return await app.ready
      .then(async () => {
        app.resolve(tabLifetime).bind(close);
        if (import.meta.hot) import.meta.hot.dispose(close);
        return createRouterEntry({
          options: { context: {} },
          Wrap: app.resolve(routerScope),
          close,
          dev: import.meta.env.DEV,
          server: import.meta.env.SSR,
        });
      })
      .catch(async (error) => {
        await close().catch((cleanup) => {
          if (cleanup !== error) console.error(cleanup);
        });
        throw error;
      });
  } catch (error) {
    stop.tools.abort(abortReasons.closed);
    await tools?.closed;
    throw error;
  }
}
