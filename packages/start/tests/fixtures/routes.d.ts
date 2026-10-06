import type { Route as AuthRoute } from "../../src/routes/api.auth.ts";
import type { Route as RootRoute } from "../../src/routes/root.tsx";

/**
 * The base's type check reads apps/start-min's route tree, where auth is off. This adds the auth
 * part's route the way a generated tree with auth on declares it; apps never read this file.
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
  }
}
