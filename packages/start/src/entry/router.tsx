import { abortReasons } from "../errors";
import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import type { Observe } from "@tinker/core";
import { createScope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import { extensions } from "#tinker/app";
import { sync, telemetry } from "#tinker/parts";
import { router } from "#tinker/router";
import { routeTree } from "#tinker/routes";
import { env } from "../env";
import { pageEvents, tabStop } from "../parts/sync/client/tab";
import { TinkerError, TinkerNotFound } from "./fallbacks";

/** Server renders borrow the process observer; each tab owns its telemetry root. */
let serverTelemetry: { observe: Observe.Config; close: undefined } | undefined;
let serverTelemetryPending: Promise<NonNullable<typeof serverTelemetry>> | undefined;

async function loadServerTelemetry() {
  const { getRenderObserver } = await import("./server");
  return (serverTelemetry = { observe: await getRenderObserver(), close: undefined });
}

const readTelemetry = createIsomorphicFn()
  .server(() => serverTelemetry ?? (serverTelemetryPending ??= loadServerTelemetry()))
  .client(async () => {
    const toolStop = new AbortController();
    const tools = createScope({
      signal: toolStop.signal,
      extensions: telemetry.extensions,
      tags: [env({}), telemetry.tags],
    });
    await tools.ready;
    return {
      observe: tools.resolve(telemetry.observe),
      close() {
        toolStop.abort(abortReasons.closed);
        return tools.closed;
      },
    };
  });

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
 * Start calls this once per server render and once per browser tab. Only a tab closes its
 * telemetry root after the app root. With sync on, the app root holds the tab's sync state, and
 * the router gets sync's context, dehydrate, and hydrate; a real page hide closes the tab.
 */
export async function getRouter() {
  const reading = readTelemetry();
  const tools = reading instanceof Promise ? await reading : reading;
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    extensions: [sync.extensions, extensions],
    observe: tools.observe,
    tags: [tabStop(stop.signal), pageEvents(readPage())],
  });
  let tab: Awaited<ReturnType<typeof sync.router.factory>>;
  try {
    await app.ready;
    tab = app.resolve(sync.router);
  } catch (error) {
    stop.abort(abortReasons.closed);
    await app.closed;
    await tools.close?.();
    throw error;
  }
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      stop.abort(abortReasons.closed);
      const end = await app.closed;
      const toolEnd = await tools.close?.();
      for (const result of [end, toolEnd]) {
        if (result?.status === "failed") throw result.error;
        if (result?.teardownErrors?.length) throw result.teardownErrors.at(0);
      }
    })());
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
