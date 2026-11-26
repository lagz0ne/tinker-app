import { createRootRouteWithContext, createRoute, Outlet } from "@tanstack/react-router";
import type { Scope } from "@tinkered/core";

import { baseVersion } from "~/components/health";

import { greet } from "@/greet";
import { Greeting } from "@/greet/greeting";
import { DayBoard, MyBookings, RoomsHome } from "@/rooms/pages";
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

// Room booking: each view reads its keyed part, so no route loads anything.
const rooms = createRoute({ getParentRoute: () => root, path: "/rooms", component: RoomsHome });

// The signed-in person's own bookings in one office, on every day.
const mine = createRoute({
  getParentRoute: () => root,
  path: "/rooms/$office/mine",
  component: () => <MyBookings officeId={mine.useParams().office} />,
});

const day = createRoute({
  getParentRoute: () => root,
  path: "/rooms/$office/$day",
  component: () => {
    const { office, day: date } = day.useParams();
    return <DayBoard officeId={office} day={date} />;
  },
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

export const routeTree = root.addChildren([index, todo, rooms, mine, day, tinker]);
