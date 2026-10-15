import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import type { Sync } from "~/components/sync";

import style from "@/style.css?url";

/** The app owns its page shell and stylesheet. */
export const Route = createRootRouteWithContext<{
  bootstrap: () => Promise<Sync.Snapshot>;
  account: () => Promise<string | null>;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Issue board" },
    ],
    links: [{ rel: "stylesheet", href: style }],
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
