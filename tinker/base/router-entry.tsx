import { createRouter } from "@tanstack/react-router";
import type { RouterConstructorOptions, RouterHistory } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
import { extension, resource, tag } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import type { ReactNode } from "react";

import { TinkerError, TinkerNotFound } from "./fallbacks";
import { renderObservation } from "./observe";

export type RouteTree = (typeof import("#tinker/routes"))["routeTree"];
type Options = RouterConstructorOptions<RouteTree, "never", false, RouterHistory, object>;
export type RouterOptions = Partial<Omit<Options, "routeTree" | "Wrap" | "context">>;
export type RouterHooks = Pick<Options, "context" | "dehydrate" | "hydrate">;

/** Each server render borrows its request's observer; the command owns browser observation. */
export function readRenderObservation() {
  return getGlobalStartContext()?.scope?.resolve(renderObservation);
}

/** React borrows the current app root through its native provider contract. */
export const routerScope = extension({
  label: "router.scope",
  hooks: {
    async start({ next, scope }) {
      await next();
      return function Wrap({ children }: { children?: ReactNode }) {
        return <ScopeProvider scope={scope}>{children}</ScopeProvider>;
      };
    },
  },
});

export const pageEvents = tag<EventTarget | undefined>({
  label: "router.pageEvents",
  default: undefined,
});

/** A real page hide closes the command's roots; a cached page keeps them. */
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

/** Outside dev the route tree loads on the first router and is shared after that. Dev imports it
 * on each router, so a route edit shows without a restart. */
let routes: Promise<typeof import("#tinker/routes")> | undefined;

/** Load Start's route tree lazily and attach its fallback views and provider. */
export async function createRouterEntry({
  options,
  Wrap,
  close,
  dev,
  server,
}: {
  options: RouterOptions & RouterHooks;
  Wrap: Options["Wrap"];
  close: () => Promise<void>;
  dev: boolean;
  server: boolean;
}) {
  const { routeTree } = await (dev
    ? import("#tinker/routes")
    : (routes ??= import("#tinker/routes")));
  return Object.assign(
    createRouter({
      scrollRestoration: true,
      defaultErrorComponent: (props) => <TinkerError {...props} dev={dev} server={server} />,
      defaultNotFoundComponent: TinkerNotFound,
      ...options,
      routeTree,
      Wrap,
    }),
    { close },
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<typeof createRouterEntry>>;
  }
}
