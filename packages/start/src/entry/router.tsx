import { createRouter } from "@tanstack/react-router";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import { createScope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import { extensions } from "#tinker/app";
import { router } from "#tinker/router";
import { routeTree } from "#tinker/routes";
import { TinkerError, TinkerNotFound } from "./fallbacks.tsx";

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

/** Start calls this once per server render and once per browser tab. */
export async function getRouter() {
  const stop = new AbortController();
  const app = createScope({ signal: stop.signal, extensions });
  await app.ready;
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= Promise.resolve().then(async () => {
      stop.abort();
      const end = await app.closed;
      if (end.status === "failed") throw end.error;
      if (end.teardownErrors?.length) throw end.teardownErrors.at(0);
    }));
  if (import.meta.hot) import.meta.hot.dispose(close);
  return Object.assign(
    createRouter({
      scrollRestoration: true,
      defaultErrorComponent: TinkerError,
      defaultNotFoundComponent: TinkerNotFound,
      ...router(routeTree),
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
