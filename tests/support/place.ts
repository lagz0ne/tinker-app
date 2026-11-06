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
 * The page a test opened: its router, its address, the count of its route's reads, and the one stop for all three.
 * Nothing here is shared: no `window`, no `document`, no listener that outlives the test.
 */
export type PlacePage = {
  router: AnyRouter;
  history: RouterHistory;
  loads: () => number;
  close: () => Promise<void>;
};

let reads = 0;

/**
 * The page's route as `src/routes.tsx` declares it: the place is its search param, and its loader counts its reads.
 *
 * Bun has no DOM, so nothing of a browser is faked. The router is told its `origin` (it then never reads a `window`),
 * and `isServer: false` keeps it off the server path, where a navigation would be a no-op. The address is the
 * router's own memory history.
 */
const pageOver = async (history: RouterHistory): Promise<PlacePage> => {
  const root = createRootRoute({ component: () => null });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/p/$project",
    gcTime: 0,
    validateSearch: placeSearch,
    loader: () => {
      reads += 1;

      return { reads };
    },
    component: () => null,
  });

  const router: AnyRouter = createRouter({
    routeTree: root.addChildren([page]),
    history,
    // The router's own origin, so it takes no origin from a `window`: there is none here, and none is made.
    origin: "http://localhost",
    // A route loader makes TanStack hold a navigation for its pending minimum; 0 keeps a test's move immediate.
    defaultPendingMinMs: 0,
    // No `document` here: without this the router reads as a server, and every navigation is a no-op.
    isServer: false,
  });

  // The tab's Transitioner loads the route on every history move, and a navigation settles when that load renders.
  // No renderer here, so a test binds the same load and nothing else; `close` takes the binding back out.
  const failed: unknown[] = [];
  const inFlight: Promise<void>[] = [];
  let closed = false;

  const stop = history.subscribe(() => {
    if (closed) return;

    inFlight.push(
      router.load().catch((error: unknown) => {
        failed.push(error);
      }),
    );
  });

  await router.load();

  const close = async () => {
    closed = true;
    stop();
    // Every load the binding started is waited for here, so nothing is still running once a test returns.
    await Promise.all(inFlight);
    inFlight.length = 0;

    const first = failed[0];

    if (first !== undefined) throw first;
  };

  return { router, history, loads: () => reads, close };
};

/** The page opened at these entries, over a history of its own, with the loader's count. */
export const placePageOpened = async (entries: readonly string[] = ["/p/shop/"]) => {
  reads = 0;
  const history = createMemoryHistory({ initialEntries: [...entries] });

  return pageOver(history);
};

/**
 * The page opened again on the entry a reload left: a new router over the browser's own history, so the page's own
 * memory is gone and the address and the entry's state are all it has. Its `close` stops its own binding only.
 */
export const placePageReloaded = (history: RouterHistory) => pageOver(history);

/** The tags a page binds: its router, and the browser's address. */
export const placeTags = (router: AnyRouter, history: RouterHistory) => [
  placeRouter(router),
  placeAddress(history),
];

/** A wait for the work a move leaves behind to settle. */
export const placeFlush = () => new Promise((resolve) => setTimeout(resolve, 0));
