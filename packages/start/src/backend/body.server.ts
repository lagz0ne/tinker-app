import { operation, resource } from "@tinker/core";
import type { Operation } from "@tinker/core";
import { startServer } from "../modules.server";

/** Keeps the body owner synchronous while the module loads through this operation's deps. */
const transferResponseBody = operation({
  label: "start.transferResponseBody",
  depends: { startServer },
  run: async ({ startServer }, { input }: Operation.Ctx<{ source: Response; target: Response }>) =>
    startServer.transferResponseBodyOwnership(input.source, input.target),
});

/** Retains request work until the consumer ends, fails, or cancels the body. */
export const responseBodies = resource({
  label: "start.responseBodies",
  target: "scope",
  depends: { transfer: transferResponseBody.controller },
  factory: ({ transfer }, ctx) => {
    const readers = new Set<{
      reader: ReadableStreamDefaultReader<Uint8Array>;
      finish: (graceful: boolean) => Promise<void>;
      cancelled: boolean;
    }>();
    ctx.defer(async () => {
      const results = await Promise.allSettled(
        [...readers].map(async (owned) => {
          owned.cancelled = true;
          readers.delete(owned);
          const ended = await Promise.allSettled([owned.reader.cancel(), owned.finish(false)]);
          for (const result of ended) if (result.status === "rejected") throw result.reason;
        }),
      );
      for (const result of results) if (result.status === "rejected") throw result.reason;
    });
    return {
      isResponse(value: unknown): value is Response {
        return value instanceof Response;
      },
      hold(
        response: Response,
        finish: (graceful: boolean) => Promise<void>,
      ): Response | Promise<Response> {
        if (response.body === null) {
          return finish(true).then(() => response);
        }
        const reader = response.body.getReader();
        const owned = { reader, finish, cancelled: false };
        readers.add(owned);
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                readers.delete(owned);
                await finish(!owned.cancelled);
                if (!owned.cancelled) controller.close();
              } else if (!owned.cancelled) controller.enqueue(part.value);
            } catch (error) {
              readers.delete(owned);
              await finish(false);
              if (!owned.cancelled) controller.error(error);
            }
          },
          async cancel(reason) {
            owned.cancelled = true;
            readers.delete(owned);
            const results = await Promise.allSettled([finish(false), reader.cancel(reason)]);
            for (const result of results) {
              if (result.status === "rejected") throw result.reason;
            }
          },
        });
        return transfer.run({
          input: {
            source: response,
            target: new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
          },
        });
      },
    };
  },
});
