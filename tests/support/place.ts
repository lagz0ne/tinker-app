import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
  type RouterHistory,
} from "@tanstack/react-router";

import { placeAddress, placeRouter, placeSearch } from "~/components/place";

/**
 * Bun has no DOM, so TanStack's client router gets the two things it reads before a route runs: a `window` with an
 * origin, and `isServer: false` (with no `document` it would call itself a server router, and a navigation would be a
 * no-op). Nothing else of a browser is faked: the address is the router's own history, and a test walks it.
 */
Object.assign(globalThis, {
  window: {
    origin: "http://localhost",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
});

let loads = 0;

/** The page's route as `src/routes.tsx` declares it: the place is its search param, and its loader counts its reads. */
const routerOver = async (history: RouterHistory): Promise<AnyRouter> => {
  const root = createRootRoute({ component: () => null });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/p/$project",
    gcTime: 0,
    validateSearch: placeSearch,
    loader: () => {
      loads += 1;

      return { loads };
    },
    component: () => null,
  });

  const router: AnyRouter = createRouter({
    routeTree: root.addChildren([page]),
    history,
    // A route loader makes TanStack hold a navigation for its pending minimum; 0 keeps a test's move immediate.
    defaultPendingMinMs: 0,
    // No `document` here: without this the router reads as a server, and every navigation is a no-op.
    isServer: false,
  });

  // The tab's Transitioner loads the route on every history move, and a navigation settles when that load renders.
  // No renderer here, so a test binds the same load and nothing else.
  history.subscribe(() => {
    void router.load();
  });

  await router.load();

  return router;
};

/** The page opened at these entries, over a history of its own, with the loader's count. */
export const placePageOpened = async (entries: readonly string[] = ["/p/shop/"]) => {
  loads = 0;
  const history = createMemoryHistory({ initialEntries: [...entries] });

  return { history, router: await routerOver(history), loads: () => loads };
};

/**
 * The page opened again on the entry a reload left: a new router over the browser's own history, so the page's own
 * memory is gone and the address and the entry's state are all it has.
 */
export const placePageReloaded = (history: RouterHistory) => routerOver(history);

/** The tags a page binds: its router, and the browser's address. */
export const placeTags = (router: AnyRouter, history: RouterHistory) => [
  placeRouter(router),
  placeAddress(history),
];

/** A wait for the work a move leaves behind to settle. */
export const placeFlush = () => new Promise((resolve) => setTimeout(resolve, 0));
