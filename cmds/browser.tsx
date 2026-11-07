import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createScope } from "@tinker/core";
import { ScopeProvider } from "@tinker/react";
import { createRoot } from "react-dom/client";

import { TinkerError, TinkerNotFound } from "~/base/fallbacks";
import { abortReasons } from "~/components/errors";
import { telemetry } from "~/components/telemetry";
import { ws } from "~/components/ws";

import { api } from "@/api";
import { routeTree } from "@/routes";

/** The tab's one root. A real page hide, or a hot swap of this module, closes it. */
const stop = new AbortController();

const app = createScope({
  signal: stop.signal,
  capsules: [
    telemetry.browser({ service: "tinker-browser", console }),
    ws.client({ url: `${location.origin.replace(/^http/, "ws")}/rpc` }),
    api({ remote: ws.client }),
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
await app.ready;

const router = createRouter({
  routeTree,
  context: { scope: app },
  scrollRestoration: true,
  defaultErrorComponent: TinkerError,
  defaultNotFoundComponent: TinkerNotFound,
  Wrap: ({ children }) => <ScopeProvider scope={app}>{children}</ScopeProvider>,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("app")!).render(<RouterProvider router={router} />);
