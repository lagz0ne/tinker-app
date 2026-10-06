import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import style from "#tinker/style?url";
/** The default page shell; it links src/style.css. src/routes/__root.tsx replaces it (ADR 0106). */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Tinker app" },
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
