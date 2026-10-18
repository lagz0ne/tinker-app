import type { Route as AuthRoute } from "@/routes/api.auth.$";
import type { Route as HealthRoute } from "@/routes/api.health";
import type { Route as SyncRoute } from "@/routes/api.sync";
import type { Route as TelemetryRoute } from "@/routes/api.telemetry";

import type { routeTree } from "./routeTree";

declare module "@tanstack/react-router" {
  interface FileRoutesByPath {
    "/api/health": {
      id: "/api/health";
      path: "/api/health";
      fullPath: "/api/health";
      preLoaderRoute: typeof HealthRoute;
      parentRoute: typeof routeTree;
    };
    "/api/auth/$": {
      id: "/api/auth/$";
      path: "/api/auth/$";
      fullPath: "/api/auth/$";
      preLoaderRoute: typeof AuthRoute;
      parentRoute: typeof routeTree;
    };
    "/api/sync": {
      id: "/api/sync";
      path: "/api/sync";
      fullPath: "/api/sync";
      preLoaderRoute: typeof SyncRoute;
      parentRoute: typeof routeTree;
    };
    "/api/telemetry": {
      id: "/api/telemetry";
      path: "/api/telemetry";
      fullPath: "/api/telemetry";
      preLoaderRoute: typeof TelemetryRoute;
      parentRoute: typeof routeTree;
    };
  }
}
