import { createRootRouteWithContext, createRoute, Outlet } from "@tanstack/react-router";
import type { Scope } from "@tinker/core";

import { baseVersion } from "~/components/health";

import { api } from "@/api";
import { Greeting } from "@/greeting";
import { TodoList } from "@/todo/todo-list";

const root = createRootRouteWithContext<{ scope: Scope.Handle }>()({ component: Outlet });

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  loader: ({ context, abortController }) =>
    context.scope.run(api.greet, { input: { name: "world" }, signal: abortController.signal }),
  // A component lives in its own module, so Fast Refresh swaps it in place (a module that also
  // exports the route tree reloads the page).
  component: () => <Greeting text={index.useLoaderData().text} />,
});

// The todo feature: its view reads the live list, so the route loads nothing.
const todo = createRoute({ getParentRoute: () => root, path: "/todo", component: TodoList });

const tinker = createRoute({
  getParentRoute: () => root,
  path: "/tinker",
  component: () => (
    <main>
      <h1>Tinker base</h1>
      <p>tinker-app {baseVersion}</p>
    </main>
  ),
});

export const routeTree = root.addChildren([index, todo, tinker]);
