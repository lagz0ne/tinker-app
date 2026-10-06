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
