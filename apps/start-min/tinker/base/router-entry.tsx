import { createRouter } from "@tanstack/react-router";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { createScope, resource, tag } from "@tinker/core";
import type { Many, Observe, Resource, Scope, Tag } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";

import { abortReasons } from "~/components/errors";

import { renderObservation } from "./observe";
import { TinkerError, TinkerNotFound } from "./panics";

export type RouteTree = (typeof import("#tinker/routes"))["routeTree"];

type Options = RouterConstructorOptions<RouteTree, "never", false, RouterHistory, object>;

export type RouterOptions = Partial<Omit<Options, "routeTree" | "Wrap" | "context">>;
type RouterHooks = Pick<Options, "context" | "dehydrate" | "hydrate">;

type RouterPart = {
  extensions: Many<Scope.Extension<unknown>>;
  router: Resource.Handle<RouterHooks>;
  stop: Tag.Handle<AbortSignal>;
};

type SyncOptions = RouterHooks extends { context: unknown }
  ? { sync: RouterPart }
  : { sync?: RouterPart };

type TelemetryPart = {
  extensions: Many<Scope.Extension<unknown>>;
  tags: Tag.Bindings;
  observe: Resource.Handle<Observe.Config | undefined>;
};

/** The entry supplies the browser page; a server render has none. */
export const pageEvents = tag<EventTarget | undefined>({
  label: "router.pageEvents",
  default: undefined,
});

/** The entry's page lifetime closes its roots only on a real page hide. */
export const tabLifetime = resource({
  label: "router.tabLifetime",
  depends: { target: pageEvents },
  factory: ({ target }, { defer }) => {
    let close: (() => Promise<void>) | undefined;
    const leave = (event: Event) => {
      if (!("persisted" in event) || !event.persisted) return close?.();
    };
    target?.addEventListener("pagehide", leave);
    defer(() => target?.removeEventListener("pagehide", leave));
    return {
      bind(next: () => Promise<void>) {
        close = next;
      },
    };
  },
});

/** Bind command values now; Start loads the route tree only when it requests a router. */
export function createRouterEntry({
  sync,
  telemetry,
  toolTags = [],
  tags = [],
  extensions,
  router,
}: {
  telemetry?: TelemetryPart;
  toolTags?: Tag.Bindings;
  tags?: Tag.Bindings;
  extensions: Many<Scope.Extension<unknown>>;
  router: RouterOptions;
} & SyncOptions) {
  return async function getRouter() {
    const { routeTree } = await import("#tinker/routes");
    const readTelemetry = createIsomorphicFn()
      .server(() => ({
        observe: () => getGlobalStartContext()?.scope?.resolve(renderObservation),
        close: undefined,
      }))
      .client(async () => {
        if (!telemetry) return;
        const toolStop = new AbortController();
        const tools = createScope({
          signal: toolStop.signal,
          extensions: telemetry.extensions,
          tags: [telemetry.tags, toolTags],
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
    const tools = await readTelemetry();
    const closeTools = tools?.close;
    const stop = new AbortController();
    const app = createScope({
      signal: stop.signal,
      extensions: [sync?.extensions, extensions],
      observe: tools?.observe(),
      tags: [sync && sync.stop(stop.signal), pageEvents(readPage()), tags],
    });

    const { tab, lifetime } = await app.ready
      .then(() => ({
        tab: sync && app.resolve(sync.router),
        lifetime: app.resolve(tabLifetime),
      }))
      .catch(async (error) => {
        stop.abort(abortReasons.closed);
        await app.closed;
        await closeTools?.();
        throw error;
      });

    let closed: Promise<void> | undefined;
    async function finishClose() {
      stop.abort(abortReasons.closed);
      const end = await app.closed;
      const toolEnd = await closeTools?.();
      for (const result of [end, toolEnd]) {
        if (result?.status === "failed") throw result.error;
        if (result?.teardownErrors?.length) throw result.teardownErrors.at(0);
      }
    }
    const close = () => (closed ??= finishClose());
    lifetime.bind(close);
    if (import.meta.hot) import.meta.hot.dispose(close);

    return Object.assign(
      createRouter({
        scrollRestoration: true,
        defaultErrorComponent: TinkerError,
        defaultNotFoundComponent: TinkerNotFound,
        ...router,
        ...tab,
        routeTree,
        Wrap: ({ children }) => <ScopeProvider scope={app}>{children}</ScopeProvider>,
      }),
      { close },
    );
  };
}

declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<ReturnType<typeof createRouterEntry>>>;
  }
}
