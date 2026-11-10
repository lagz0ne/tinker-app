import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ws } from "@tinker/bun/client";
import { createScope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import { createRoot } from "react-dom/client";

import { TinkerError, TinkerNotFound } from "~/base/fallbacks";
import { abortReasons } from "~/components/errors";
import { telemetry } from "~/components/telemetry";

import { greet } from "@/greet";
import { routeTree } from "@/routes";
import { todo } from "@/todo";

/** The tab's one root. A real page hide, or a hot swap of this module, closes it. */
const stop = new AbortController();

const app = createScope({
  signal: stop.signal,
  capsules: [
    telemetry.browser({ service: "tinker-browser", console }),
    ws.client({ url: `${location.origin.replace(/^http/, "ws")}/rpc` }),
    greet.api({ remote: ws.client }),
    // The todo feature: the live list over the socket, and its calls.
    todo.board({ read: ws.client }),
    todo.api({ remote: ws.client }),
  ],
});

const close = async () => {
  stop.abort(abortReasons.closed);
  await app.closed;
};

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) void close();
});

import.meta.hot?.dispose(close);
const live = await app.ready;

const router = createRouter({
  routeTree,
  context: { scope: live },
  scrollRestoration: true,
  defaultErrorComponent: TinkerError,
  defaultNotFoundComponent: TinkerNotFound,
  Wrap: ({ children }) => <ScopeProvider scope={live}>{children}</ScopeProvider>,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("app")!).render(<RouterProvider router={router} />);
