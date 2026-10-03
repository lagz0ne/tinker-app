import { accountOwner, tabStop } from "./owner.ts";
import { syncStreaming, loadSnapshot, checkAccount } from "./events.ts";
import { syncClient, applyBootstrap } from "./sync.ts";
import { readSnapshot } from "@/lib/tinker";
import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { createScope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import { routeTree } from "@/routeTree.gen";
import { frontendSpans } from "../telemetry/state.ts";
import { history, observer, telemetry, telemetrySettings } from "../telemetry/index.ts";
const readTelemetrySettings = createIsomorphicFn()
  .server(async () => {
    const { readSettings } = await import("../backend/settings.server.ts");
    return { ...readSettings({ ...process.env }).telemetry, side: "ssr" as const };
  })
  .client(() => ({ side: "browser" as const, service: "start-scaffold", level: "info" as const }));
const bindTabClose = createIsomorphicFn()
  .server((_close: () => Promise<void>) => undefined)
  .client((close: () => Promise<void>) => {
    const leave = (event: PageTransitionEvent) => {
      if (!event.persisted) return close();
    };
    window.addEventListener("pagehide", leave);
    if (import.meta.hot)
      import.meta.hot.dispose(() => window.removeEventListener("pagehide", leave));
  });
/** Start calls this once per server render and once per browser tab. */
export async function getRouter() {
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: [telemetry],
    tags: telemetrySettings(await readTelemetrySettings()),
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    extensions: [accountOwner, syncStreaming],
    observe: await tools.resolve(observer),
    tags: [frontendSpans(() => tools.resolve(history)), tabStop(stop.signal)],
  });
  await app.ready;
  const sync = await app.resolve(syncClient);
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= Promise.resolve().then(async () => {
      await app.ready;
      stop.abort();
      const end = await app.closed;
      toolStop.abort();
      const toolEnd = await tools.closed;
      if (end.status === "failed") throw end.error;
      if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
      if (toolEnd.status === "failed") throw toolEnd.error;
      if (toolEnd.teardownErrors?.length) throw toolEnd.teardownErrors.at(0);
    }));
  bindTabClose(close);
  if (import.meta.hot) import.meta.hot.dispose(close);
  return Object.assign(
    createRouter({
      routeTree,
      context: { bootstrap: () => app.run(loadSnapshot), account: () => app.run(checkAccount) },
      dehydrate: () => sync.snapshot(),
      hydrate: async (raw) => {
        const snapshot = readSnapshot.parse(raw);
        await app.run(applyBootstrap, { input: { snapshot, version: sync.capture().version } });
        app.resolve(syncStreaming).start();
      },
      scrollRestoration: true,
      Wrap: ({ children }) => <ScopeProvider scope={app}>{children}</ScopeProvider>,
    }),
    { close },
  );
}
/** TanStack merges this registry to bind route types to this app. */
declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}
