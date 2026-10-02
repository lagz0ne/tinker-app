import { createStartHandler as createStartFetch } from "@tanstack/react-start/server";
import { defaultStreamHandler as renderStartStream } from "@tanstack/react-start/server";
import type { getRouter } from "./router.tsx";
import { holdResponse } from "./scaffold/backend/body.server.ts";
import { getBackend, closeBackend } from "./scaffold/backend/entry.server.ts";
const renderRequest = createStartFetch(async (context) => {
  const router = context.router as Awaited<ReturnType<typeof getRouter>>;
  try {
    const output = await renderStartStream(context);
    if (output instanceof Response) return holdResponse(output, () => router.close());
    return { ...output, response: await holdResponse(output.response, () => router.close()) };
  } catch (error) {
    await router.close();
    throw error;
  }
});
export default {
  async fetch(request: Request) {
    const { requestContext } = await getBackend();
    return renderRequest(request, { context: requestContext });
  },
};
export const close = closeBackend;
