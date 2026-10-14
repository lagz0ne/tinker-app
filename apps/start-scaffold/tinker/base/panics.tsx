import type { ErrorComponentProps } from "@tanstack/react-router";

/**
 * The error text the base's error page may show: the message in dev, and nothing in
 * production, so no server detail reaches a visitor. The server log keeps the error.
 * @param error - From TanStack's error boundary; why: the error a route threw.
 * @param dev - From import.meta.env.DEV; why: only a developer sees the text.
 */
export function errorDetail(error: unknown, dev: boolean): string | undefined {
  if (!dev) return undefined;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Dev only. Start answers a failed render with a bare JSON 500, and that page has no Vite
 * client, so it never sees the fix. This page keeps the body and reloads on the next update.
 * @param request - From the server entry; why: only a browser page load gets the HTML page.
 * @param response - From Start; why: every other response passes through untouched.
 */
export async function devErrorPage(request: Request, response: Response): Promise<Response> {
  const page = request.headers.get("accept")?.includes("text/html");
  const json = response.headers.get("content-type")?.includes("application/json");
  if (response.status !== 500 || !page || !json) return response;
  const body = (await response.text()).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Error</title>
    <script type="module">
      import { createHotContext } from "/@vite/client";
      createHotContext("/@tinker/dev-error").on("vite:beforeUpdate", () => location.reload());
    </script>
  </head>
  <body>
    <pre>${body}</pre>
    <p>tinker: the page failed to render; the error is in the terminal.</p>
    <p>Save a fix and this page reloads.</p>
  </body>
</html>`,
    { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * The base's error page: a production page shows no error text, and the server log gets the
 * error. It logs to the console because this POC base has no telemetry part yet.
 */
export function TinkerError({ error }: ErrorComponentProps) {
  if (import.meta.env.SSR) console.error("tinker: a route failed on the server:", error);
  const detail = errorDetail(error, import.meta.env.DEV);
  return (
    <main>
      <h1>Something went wrong</h1>
      {detail !== undefined && <pre>{detail}</pre>}
    </main>
  );
}

/** The base's 404 page; a route's own notFoundComponent, or src/router.ts, replaces it. */
export function TinkerNotFound() {
  return (
    <main>
      <h1>Not found</h1>
    </main>
  );
}
