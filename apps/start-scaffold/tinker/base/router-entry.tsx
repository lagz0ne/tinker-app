import { createRouter } from "@tanstack/react-router";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { createScope } from "@tinker/core";
import type { Many, Scope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";

import { abortReasons } from "~/components/errors";

import { renderObservation } from "./observe";
import { TinkerError, TinkerNotFound } from "./panics";

export type RouteTree = (typeof import("#tinker/routes"))["routeTree"];

export type RouterOptions = Partial<
  Omit<
    RouterConstructorOptions<RouteTree, "never", false, RouterHistory, Record<string, unknown>>,
    "routeTree" | "Wrap" | "context"
  >
>;

type Parts = Pick<
  Awaited<ReturnType<(typeof import("@tinker/start/router"))["loadRouterParts"]>>,
  "sync" | "telemetry" | "pageEvents" | "tabStop"
>;

/** Bind optional parts now; load the route tree only when Start requests a router. */
export function createRouterEntry({
  parts,
  extensions,
  router,
}: {
  parts: Parts | (() => Promise<Parts>);
  extensions: Many<Scope.Extension<unknown>>;
  router: RouterOptions;
}) {
  return async function getRouter() {
    const { sync, telemetry, pageEvents, tabStop } =
      typeof parts === "function" ? await parts() : parts;
    const { routeTree } = await import("#tinker/routes");

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
    async function finishClose() {
      stop.abort(abortReasons.closed);
      const end = await app.closed;
      const toolEnd = await tools.close?.();
      for (const result of [end, toolEnd]) {
        if (result?.status === "failed") throw result.error;
        if (result?.teardownErrors?.length) throw result.teardownErrors.at(0);
      }
    }

    const close = () => (closed ??= finishClose());

    tab.bind(close);
    if (import.meta.hot) import.meta.hot.dispose(close);

    return Object.assign(
      createRouter({
        scrollRestoration: true,
        defaultErrorComponent: TinkerError,
        defaultNotFoundComponent: TinkerNotFound,
        ...router,
        ...tab.options,
        routeTree,
        Wrap: ({ children }) => <ScopeProvider scope={app}>{children}</ScopeProvider>,
      }),
      { close },
    );
  };
}

/** TanStack binds route types to the copied router entry. */
declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<ReturnType<typeof createRouterEntry>>>;
  }
}
