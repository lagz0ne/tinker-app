import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
const step = process.env.STEP ?? "all";
const root = createRootRoute({ component: () => h("div", null, "root:", h(Outlet)) });
const index = createRoute({ getParentRoute: () => root, path: "/", loader: () => ({ text: "hello" }), component: function Idx() { return h("p", null, index.useLoaderData().text); } });
const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }), isServer: true });
await router.load();
console.log("status", router.state.status, "matches", router.state.matches.length);
try { console.log(renderToString(h(RouterProvider, { router }))); } catch (e) { console.log("throw", String(e)); }
