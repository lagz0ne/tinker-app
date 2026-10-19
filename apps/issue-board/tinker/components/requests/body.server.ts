import type { ServerResponse } from "node:http";

import { resource } from "@tinker/core";

import { startServer } from "./modules.server";

export declare namespace Requests {
  /** The Node response a host serves the request on. */
  type Outgoing = ServerResponse;
  /**
   * srvx and h3 read a Node host's response from `request.runtime.node.res`; a host that awaits
   * `beforeEnd` before its last write fails the reply when the request cannot close.
   */
  type Hosted = Request & {
    runtime: { node?: { res: Outgoing }; beforeEnd?: () => Promise<void> };
  };
}

/**
 * Ends each request before its host response ends, as the body read did: the returned join
 * closes it gracefully, and a failed close fails the reply. A response that closes first, on a
 * client abort, ends it by force. Scope close destroys the responses still open and fails with
 * any request that could not end and had no reply left to fail.
 */
export const hostResponses = resource({
  label: "start.hostResponses",
  target: "scope",
  factory: (_deps, ctx) => {
    const open = new Map<Requests.Outgoing, Promise<void>>();
    const failures: unknown[] = [];
    ctx.defer(async () => {
      for (const outgoing of open.keys()) outgoing.destroy();
      await Promise.all(open.values());
      if (failures.length) throw failures.at(0);
    });

    return {
      isHosted(request: Request): request is Requests.Hosted {
        return "runtime" in request;
      },
      endOnClose(outgoing: Requests.Outgoing, finish: (graceful: boolean) => Promise<void>) {
        let joined: Promise<void> | undefined;
        const closed = outgoing.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => outgoing.once("close", resolve));
        const ending = closed
          .then(() => (joined ? joined.then(noop, noop) : finish(outgoing.writableFinished)))
          .then(
            () => {
              open.delete(outgoing);
            },
            (error: unknown) => {
              open.delete(outgoing);
              failures.push(error);
            },
          );
        open.set(outgoing, ending);
        return () => (joined ??= finish(true));
      },
    };
  },
});

/** A joined close already failed its reply; the host owns that error. */
function noop() {}

/** Retains request work until the consumer ends, fails, or cancels the body. */
export const responseBodies = resource({
  label: "start.responseBodies",
  target: "scope",
  depends: { startServer },
  factory: async ({ startServer }, ctx) => {
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

        return startServer.transferResponseBodyOwnership(
          response,
          new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        );
      },
    };
  },
});
