import type { Sync } from "../contracts/sync.ts";
import { createRootRouteWithContext, HeadContent, Scripts, Outlet } from "@tanstack/react-router";
import styleUrl from "../style.css?url";
export const Route = createRootRouteWithContext<{ bootstrap: () => Promise<Sync.Snapshot> }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Tinkered · Start proof" },
    ],
    links: [{ rel: "stylesheet", href: styleUrl }],
  }),
  component: () => <Outlet />,
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
