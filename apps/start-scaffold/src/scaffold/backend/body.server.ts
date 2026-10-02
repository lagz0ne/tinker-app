import { transferResponseBodyOwnership } from "@tanstack/react-start/server";
/** Retains request work until the consumer ends, fails, or cancels the body. */
export async function holdResponse(
  response: Response,
  finish: (graceful: boolean) => Promise<void>,
): Promise<Response> {
  if (response.body === null) {
    await finish(true);
    return response;
  }
  const reader = response.body.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          await finish(!cancelled);
          if (!cancelled) controller.close();
        } else controller.enqueue(part.value);
      } catch (error) {
        await finish(false);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      const results = await Promise.allSettled([finish(false), reader.cancel(reason)]);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    },
  });
  return transferResponseBodyOwnership(
    response,
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
}
