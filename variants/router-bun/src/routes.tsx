import { createRootRouteWithContext, createRoute, Outlet } from "@tanstack/react-router";
import type { Scope } from "@tinker/core";

import { baseVersion } from "~/components/health";

import { greet } from "@/api/greet";

const root = createRootRouteWithContext<{ scope: Scope.Handle }>()({ component: Outlet });

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  loader: ({ context, abortController }) =>
    context.scope.run(greet, { input: { name: "world" }, signal: abortController.signal }),
  component: function Greeting() {
    return <p>{index.useLoaderData().text}</p>;
  },
});

const tinker = createRoute({
  getParentRoute: () => root,
  path: "/tinker",
  component: () => (
    <main>
      <h1>Tinker base</h1>
      <p>@tinker/start {baseVersion}</p>
    </main>
  ),
});

export const routeTree = root.addChildren([index, tinker]);
