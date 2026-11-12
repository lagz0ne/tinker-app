import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ws } from "@tinkered/bun/client";
import { createScope } from "@tinkered/core";
import { ScopeProvider } from "@tinkered/react";
import { createRoot } from "react-dom/client";

import { TinkerError, TinkerNotFound } from "~/base/fallbacks";
import { abortReasons } from "~/components/errors";
import { telemetry } from "~/components/telemetry";

import { greet } from "@/greet";
import { issues, whoMeta } from "@/issues";
import { routeTree } from "@/routes";
import { todo } from "@/todo";

/** The tab's one root. A real page hide, or a hot swap of this module, closes it. */
const stop = new AbortController();

const app = createScope({
  signal: stop.signal,
  capsules: [
    telemetry.browser({ service: "tinker-browser", console }),
    // `whoMeta`: the issue board's sign-in stand-in rides each message's meta.
    ws.client({ url: `${location.origin.replace(/^http/, "ws")}/rpc`, meta: whoMeta }),
    greet.api({ remote: ws.client }),
    // The todo feature: the live list over the socket, and its calls.
    todo.board({ read: ws.client }),
    todo.api({ remote: ws.client }),
    // The issue board: the team's parts over the socket, and its calls.
    issues.board({ read: ws.client }),
    issues.api({ remote: ws.client }),
  ],
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) stop.abort(abortReasons.closed);
});

import.meta.hot?.dispose(async () => {
  stop.abort(abortReasons.closed);
  await app.closed;
});

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
