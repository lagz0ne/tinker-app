import { serveMain } from "~/base/bun-host";

/**
 * A host whose `/api/stream` sends one chunk, stays quiet for 16 s, then sends a second and ends:
 * longer than Bun's 10 s default idle timeout, which fires up to 4 s late. It runs until a signal
 * stops it.
 */
await serveMain(
  async ({ signal }) => ({
    fetch: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("one\n"));
            await Bun.sleep(16_000);
            controller.enqueue(new TextEncoder().encode("two\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/plain" } },
      ),
    closed: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  }),
  {},
);
