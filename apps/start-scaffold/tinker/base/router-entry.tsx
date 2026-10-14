import { createRouter } from "@tanstack/react-router";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { createScope } from "@tinker/core";
import type { Many, Scope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";

import { abortReasons } from "~/components/errors";

import { routeTree } from "#tinker/routes";

import { renderObservation } from "./observe";
import { TinkerError, TinkerNotFound } from "./panics";

export type RouteTree = typeof routeTree;

export type RouterOptions = (
  routeTree: RouteTree,
) => Partial<
  Omit<
    RouterConstructorOptions<RouteTree, "never", false, RouterHistory, Record<string, unknown>>,
    "routeTree" | "Wrap" | "context"
  >
>;

type Parts = Pick<
  typeof import("@tinker/start/router"),
  "sync" | "telemetry" | "pageEvents" | "tabStop"
> & {
  extensions: Many<Scope.Extension<unknown>>;
  router: RouterOptions;
};

/** The command passes optional parts; only browser tabs own a telemetry root. */
export async function createRouterEntry({
  sync,
  telemetry,
  pageEvents,
  tabStop,
  extensions,
  router,
}: Parts) {
  const readTelemetry = createIsomorphicFn()
    .server(() => ({
      observe: () => getGlobalStartContext()?.scope?.resolve(renderObservation),
      close: undefined,
    }))
    .client(async () => {
      const toolStop = new AbortController();
      const tools = createScope({
        signal: toolStop.signal,
        extensions: telemetry.extensions,
        tags: telemetry.tags,
      });
      await tools.ready;
      return {
        observe() {
          return tools.resolve(telemetry.observe);
        },
        close() {
          toolStop.abort(abortReasons.closed);
          return tools.closed;
        },
      };
    });

  const readPage = createIsomorphicFn()
    .server((): EventTarget | undefined => undefined)
    .client(() => window);

  const reading = readTelemetry();
  const tools = reading instanceof Promise ? await reading : reading;

  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    extensions: [sync.extensions, extensions],
    observe: tools.observe(),
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

/** TanStack binds route types to the copied router entry. */
declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<typeof createRouterEntry>>;
  }
}
