import type { Route as AuthRoute } from "../../src/routes/api.auth";
import type { Route as SyncRoute } from "../../src/routes/api.sync";
import type { Route as RootRoute } from "../../src/routes/root";

/**
 * The base's type check reads apps/start-min's route tree, where auth and sync are off. This adds
 * their routes the way a generated tree with them on declares them; apps never read this file.
 */
declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/api/auth/$": {
      id: "/api/auth/$";
      path: "/api/auth/$";
      fullPath: "/api/auth/$";
      preLoaderRoute: typeof AuthRoute;
      parentRoute: typeof RootRoute;
    };
    "/api/sync": {
      id: "/api/sync";
      path: "/api/sync";
      fullPath: "/api/sync";
      preLoaderRoute: typeof SyncRoute;
      parentRoute: typeof RootRoute;
    };
  }
}
