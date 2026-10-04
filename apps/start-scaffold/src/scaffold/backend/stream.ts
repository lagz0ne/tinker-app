import { z } from "zod";
import { operation, resource } from "@tinker/core";
import { auth, database } from "@/lib/tinker.server";
import { requestHeaders } from "./headers.server.ts";
import { notifications } from "./notifications.ts";
import { backendStop, requestStop } from "./lifetime.ts";
import { streamCursor } from "../protocol.ts";
import type { Stream } from "../protocol.ts";
import { raise } from "../errors.ts";
/** Cookie caches and session refresh are disabled on this long-lived request. */
const liveAccount = operation({
  label: "sync.liveAccount",
  depends: { auth, headers: requestHeaders },
  run: async ({ auth, headers }) =>
    (
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
    )?.user.id ?? null,
});
/** The request resource owns the returned body, including pulls after the opening operation ends. */
export const eventStream = resource({
  label: "sync.stream",
  target: "session",
  depends: { database, notifications, account: liveAccount, backendStop, requestStop },
  factory: async ({ database, notifications, account, backendStop, requestStop }, ctx) => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, backendStop, requestStop, ctx.signal]);
    let subscription: Awaited<ReturnType<typeof notifications.subscribe>> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    const close = () => {
      if (ended) return;
      ended = true;
      stop.abort();
      if (subscription) notifications.close(subscription);
      output?.close();
    };
    signal.addEventListener("abort", close, { once: true });
    ctx.defer(() => {
      close();
      signal.removeEventListener("abort", close);
    });
    return {
      async open(initial: Stream.Cursor) {
        subscription = await notifications.subscribe(close);
        if (signal.aborted) {
          notifications.close(subscription);
          raise("Cancelled", {});
        }
        const changes = subscription;
        const openingWake = notifications.revision();
        const initialAccount = await account.run();
        if (initial.private && initial.private.accountId !== initialAccount)
          raise("StreamDenied", {});
        const [{ and, or, eq, gt, asc }, { event }] = await Promise.all([
          import("drizzle-orm"),
          import("./sync.schema.ts"),
        ]);
        const cursor = { ...initial, private: initial.private ? { ...initial.private } : null };
        const lease = ctx.clock.currentTimeMillis() + 30_000;
        const encoder = new TextEncoder();
        let afterWake = -1;
        const expectedAccount = cursor.private?.accountId ?? null;
        let authorizedWake = initialAccount === expectedAccount ? openingWake : -1;
        let greeted = false;
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              output = controller;
              if (ended) controller.close();
              else if (signal.aborted) close();
            },
            async pull(controller) {
              try {
                while (!ended) {
                  const wake = await Promise.resolve().then(async () => {
                    if (notifications.ended(changes) || ctx.clock.currentTimeMillis() >= lease) {
                      close();
                      return notifications.revision();
                    }
                    const wake = notifications.revision();
                    if (wake !== authorizedWake) {
                      const current = await account.run();
                      authorizedWake = wake;
                      if (ended) return wake;
                      if (current !== expectedAccount) {
                        output?.enqueue(
                          encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n'),
                        );
                        close();
                      }
                    }
                    return notifications.revision();
                  });
                  if (ended) return;
                  const replayed = await Promise.resolve().then(async () => {
                    if (wake === afterWake) return false;
                    const rows = await database
                      .select()
                      .from(event)
                      .where(
                        or(
                          and(eq(event.stream, "public"), gt(event.revision, cursor.public)),
                          cursor.private
                            ? and(
                                eq(event.stream, cursor.private.accountId),
                                gt(event.revision, cursor.private.revision),
                              )
                            : undefined,
                        ),
                      )
                      .orderBy(asc(event.stream), asc(event.revision))
                      .limit(100);
                    await Promise.resolve().then(async () => {
                      const replayWake = notifications.revision();
                      if (replayWake === authorizedWake) return;
                      const current = await account.run();
                      authorizedWake = replayWake;
                      if (ended) return;
                      if (current !== expectedAccount) {
                        output?.enqueue(
                          encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n'),
                        );
                        close();
                      }
                    });
                    if (ended) return true;
                    if (!rows.length) {
                      afterWake = wake;
                      return false;
                    }
                    for (const row of rows) {
                      if (row.stream === "public") cursor.public = row.revision;
                      else if (cursor.private) cursor.private.revision = row.revision;
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: changes\nid: ${JSON.stringify(cursor)}\ndata: ${JSON.stringify({ kind: "changes", events: rows })}\n\n`,
                      ),
                    );
                    return true;
                  });
                  if (replayed) return;
                  const delivered = await Promise.resolve().then(async () => {
                    if (ended || notifications.revision() !== afterWake) return false;
                    if (!greeted) {
                      greeted = true;
                      controller.enqueue(encoder.encode(": connected\n\n"));
                      return true;
                    }
                    const waiting = new AbortController();
                    const waitingSignal = AbortSignal.any([signal, waiting.signal]);
                    try {
                      const outcome = await Promise.race([
                        notifications.wait(changes, afterWake, waitingSignal).then(() => "changed"),
                        ctx.clock.sleep(10_000, waitingSignal).then(() => "heartbeat"),
                      ]);
                      if (outcome !== "heartbeat") return false;
                      await Promise.resolve().then(async () => {
                        const heartbeatWake = notifications.revision();
                        const current = await account.run();
                        authorizedWake = heartbeatWake;
                        if (ended) return;
                        if (current !== expectedAccount) {
                          output?.enqueue(
                            encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n'),
                          );
                          close();
                        }
                      });
                      await Promise.resolve().then(async () => {
                        if (ended) return;
                        const latestWake = notifications.revision();
                        if (latestWake === authorizedWake) return;
                        const latestAccount = await account.run();
                        authorizedWake = latestWake;
                        if (ended) return;
                        if (latestAccount !== expectedAccount) {
                          output?.enqueue(
                            encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n'),
                          );
                          close();
                        }
                      });
                      if (!ended) controller.enqueue(encoder.encode(": heartbeat\n\n"));
                      return true;
                    } finally {
                      waiting.abort();
                    }
                  });
                  if (delivered) return;
                }
              } catch (error) {
                if (signal.aborted) {
                  close();
                  return;
                }
                ended = true;
                stop.abort();
                notifications.close(changes);
                controller.error(error);
              }
            },
            cancel() {
              output = undefined;
              close();
            },
          },
          { highWaterMark: 0 },
        );
        return body;
      },
    };
  },
});
export const openSync = operation({
  label: "sync.open",
  input: z.object({ cursor: streamCursor }),
  depends: { stream: eventStream },
  run: async ({ stream }, ctx) => stream.open(ctx.input.cursor),
});
