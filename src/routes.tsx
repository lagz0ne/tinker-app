import { createRootRouteWithContext, createRoute, Outlet } from "@tanstack/react-router";
import type { Scope } from "@tinkered/core";

import { baseVersion } from "~/components/health";

import { greet } from "@/greet";
import { Greeting } from "@/greet/greeting";
import { Board, IssuesHome, Thread } from "@/issues/board";
import { TodoList } from "@/todo/todo-list";

const root = createRootRouteWithContext<{ scope: Scope.Handle }>()({ component: Outlet });

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  loader: ({ context, abortController }) =>
    context.scope.run(greet.api.greet, {
      input: { name: "world" },
      signal: abortController.signal,
    }),
  // A component lives in its own module, so Fast Refresh swaps it in place (a module that also
  // exports the route tree reloads the page).
  component: () => <Greeting text={index.useLoaderData().text} />,
});

// The todo feature: its view reads the live list, so the route loads nothing.
const todo = createRoute({ getParentRoute: () => root, path: "/todo", component: TodoList });

// The issue board: each view reads its keyed part, so no route loads anything.
const issues = createRoute({ getParentRoute: () => root, path: "/issues", component: IssuesHome });

const team = createRoute({
  getParentRoute: () => root,
  path: "/issues/$team",
  // The team's page, then the open thread beside it. The child route draws in this `Outlet`, so
  // a page of the feature knows nothing about the route tree.
  component: () => (
    <>
      <Board teamId={team.useParams().team} />
      <Outlet />
    </>
  ),
});

const thread = createRoute({
  getParentRoute: () => team,
  path: "$id",
  component: () => <Thread teamId={team.useParams().team} issueId={thread.useParams().id} />,
});

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

export const routeTree = root.addChildren([
  index,
  todo,
  issues,
  team.addChildren([thread]),
  tinker,
]);
