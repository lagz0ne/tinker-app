import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import { createScope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import { extensions } from "#tinker/app";
import { sync, telemetry } from "#tinker/parts";
import { router } from "#tinker/router";
import { routeTree } from "#tinker/routes";
import { env } from "../env.ts";
import { pageEvents, tabStop } from "../parts/sync/client/tab.ts";
import { TinkerError, TinkerNotFound } from "./fallbacks.tsx";

/** A server render reads the process env; a tab has none. */
const readEnv = createIsomorphicFn()
  .server(() => ({ ...process.env }))
  .client(() => ({}));
/** A tab's page events (for its lifetime); a server render has no page. */
const readPage = createIsomorphicFn()
  .server((): EventTarget | undefined => undefined)
  .client(() => window);

/** The app's route tree, base routes included. */
export type RouteTree = typeof routeTree;

/**
 * What src/router.ts, a named file (ADR 0106), exports as `router`: the router options the base
 * does not own. It gets the route tree, for route masks.
 */
export type RouterOptions = (
  routeTree: RouteTree,
) => Partial<
  Omit<
    RouterConstructorOptions<RouteTree, "never", false, RouterHistory, Record<string, unknown>>,
    "routeTree" | "Wrap" | "context"
  >
>;

/**
 * Start calls this once per server render and once per browser tab. The telemetry root observes
 * the app root, and closes after it. With sync on, the app root holds the tab's sync state, and
 * the router gets sync's context, dehydrate, and hydrate; a real page hide closes the tab.
 */
export async function getRouter() {
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: telemetry.extensions,
    tags: [env(readEnv()), telemetry.tags],
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    extensions: [sync.extensions, extensions],
    observe: tools.resolve(telemetry.observe),
    tags: [tabStop(stop.signal), pageEvents(readPage())],
  });
  const tab = await app.ready
    .then(() => app.resolve(sync.router))
    .catch(async (error: unknown) => {
      stop.abort();
      await app.closed;
      toolStop.abort();
      await tools.closed;
      throw error;
    });
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
  tab.bind(close);
  if (import.meta.hot) import.meta.hot.dispose(close);
  return Object.assign(
    createRouter({
      scrollRestoration: true,
      defaultErrorComponent: TinkerError,
      defaultNotFoundComponent: TinkerNotFound,
      ...router(routeTree),
      ...tab.options,
      routeTree,
      Wrap: ({ children }) => <ScopeProvider scope={app}>{children}</ScopeProvider>,
    }),
    { close },
  );
}

/** TanStack merges this registry to bind route types to the app's router. */
declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}
