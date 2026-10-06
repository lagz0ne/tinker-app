import { operation, resource } from "@tinker/core";
import { z } from "zod";
import { auth, database } from "#tinker/app.server";
import { requestHeaders } from "../../backend/headers.server.ts";
import { backendStop, requestStop } from "../../backend/lifetime.ts";
import { raise } from "../../errors.ts";
import { notifications } from "./notifications.server.ts";
import { streamCursor } from "./protocol.ts";
import type { Stream } from "./protocol.ts";

/** Cookie caches and session refresh are off on this long-lived request. */
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

/** The frame a stream sends, then closes on, when its account signed out or changed. */
const accountChange = 'event: account\ndata: {"kind":"account-change"}\n\n';

/**
 * The request resource owns the returned body, including pulls after the opening operation ends.
 * The stream replays events after the cursor, greets once, then waits for a wake or a 10 s
 * heartbeat. Each wake re-checks the account; it closes at a 30 s lease, on a broken listener,
 * or on an account change.
 */
export const eventStream = resource({
  label: "sync.stream",
  target: "session",
  depends: { database, notifications, account: liveAccount, backendStop, requestStop },
  factory: async (
    { database, notifications, account, backendStop, requestStop },
    { signal: cleanup, defer, clock },
  ) => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, backendStop, requestStop, cleanup]);
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
    defer(() => {
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
          import("./schema.ts"),
        ]);
        const cursor = { ...initial, private: initial.private ? { ...initial.private } : null };
        const lease = clock.currentTimeMillis() + 30_000;
        const encoder = new TextEncoder();
        const expectedAccount = cursor.private?.accountId ?? null;
        let afterWake = -1;
        let authorizedWake = initialAccount === expectedAccount ? openingWake : -1;
        let greeted = false;
        /** Read the account at this wake; a change sends its frame and closes the stream. */
        const recheck = async (wake: number) => {
          const current = await account.run();
          authorizedWake = wake;
          if (ended) return;
          if (current !== expectedAccount) {
            output?.enqueue(encoder.encode(accountChange));
            close();
          }
        };
        /** The lease, the listener, and a wake since the last account read. */
        const checkWake = async () => {
          if (notifications.ended(changes) || clock.currentTimeMillis() >= lease) {
            close();
            return notifications.revision();
          }
          const wake = notifications.revision();
          if (wake !== authorizedWake) await recheck(wake);
          return notifications.revision();
        };
        /** Up to 100 events after the cursor: public ones, and the account's own. */
        const readRows = () =>
          database
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
        /** The rows after the cursor, as one frame; false when there are none. */
        const replay = async (
          wake: number,
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) => {
          if (wake === afterWake) return false;
          const rows = await readRows();
          const replayWake = notifications.revision();
          if (replayWake !== authorizedWake) await recheck(replayWake);
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
        };
        /** The greeting once, then a wake (false) or a heartbeat after 10 s (true). */
        const greetOrWait = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
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
              clock.sleep(10_000, waitingSignal).then(() => "heartbeat"),
            ]);
            if (outcome !== "heartbeat") return false;
            await recheck(notifications.revision());
            if (!ended) {
              const latestWake = notifications.revision();
              if (latestWake !== authorizedWake) await recheck(latestWake);
            }
            if (!ended) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            return true;
          } finally {
            waiting.abort();
          }
        };
        return new ReadableStream<Uint8Array>(
          {
            start(controller) {
              output = controller;
              if (ended) controller.close();
              else if (signal.aborted) close();
            },
            async pull(controller) {
              try {
                while (!ended) {
                  const wake = await checkWake();
                  if (ended) return;
                  if (await replay(wake, controller)) return;
                  if (await greetOrWait(controller)) return;
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
      },
    };
  },
});

export const openSync = operation({
  label: "sync.open",
  input: z.object({ cursor: streamCursor }),
  depends: { stream: eventStream },
  run: async ({ stream }, { input }) => stream.open(input.cursor),
});
