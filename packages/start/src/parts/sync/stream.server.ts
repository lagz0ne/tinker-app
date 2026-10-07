import { operation, resource } from "@tinker/core";
import { z } from "zod";
import { auth, database } from "#tinker/app.server";
import { requestHeaders } from "../../backend/headers.server";
import { backendStop, requestStop } from "../../backend/lifetime";
import { raise } from "../../errors";
import { notifications } from "./notifications.server";
import { streamCursor } from "./protocol";
import type { Stream } from "./protocol";

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

/** A finished wait has no error to report and needs no per-wait exception stack. */
const waitDone = Symbol("sync.waitDone");

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
    let watching: Promise<void> | undefined;
    let activity = Promise.withResolvers<boolean>();
    const close = () => {
      if (ended) return;
      ended = true;
      stop.abort(waitDone);
      activity.resolve(false);
      if (subscription) notifications.close(subscription);
      output?.close();
    };
    signal.addEventListener("abort", close, { once: true });
    defer(async () => {
      close();
      signal.removeEventListener("abort", close);
      await watching;
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
          import("./schema"),
        ]);
        const cursor = { ...initial, private: initial.private ? { ...initial.private } : null };
        const lease = clock.currentTimeMillis() + 30_000;
        const encoder = new TextEncoder();
        const expectedAccount = cursor.private?.accountId ?? null;
        let afterWake = -1;
        let authorizedWake = initialAccount === expectedAccount ? openingWake : -1;
        let greeted = false;
        let checking: Promise<void> | undefined;
        /** Read the account at this wake; a change sends its frame and closes the stream. */
        const recheck = (wake: number): Promise<void> => {
          checking ??= account
            .run()
            .then((current) => {
              authorizedWake = wake;
              if (ended) return;
              if (current !== expectedAccount) {
                output?.enqueue(encoder.encode(accountChange));
                close();
              }
            })
            .finally(() => {
              checking = undefined;
            });
          return checking;
        };
        /** The lease, the listener, and a wake since the last account read. */
        const checkWake = async () => {
          if (notifications.ended(changes) || clock.currentTimeMillis() >= lease) {
            close();
            return notifications.revision();
          }
          while (!ended && notifications.revision() !== authorizedWake)
            await recheck(notifications.revision());
          return notifications.revision();
        };
        /** Up to 100 events after the cursor: public ones, and the account's own. */
        const readRows = () =>
          notifications.share(JSON.stringify(cursor), () =>
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
              .limit(100),
          );
        /** The rows after the cursor, as one frame; false when there are none. */
        const replay = async (
          wake: number,
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) => {
          if (wake === afterWake) return false;
          const rows = await readRows();
          await checkWake();
          if (ended) return true;
          if (!rows.length) {
            afterWake = wake;
            return false;
          }
          /** A short page has every row at this wake, so the next pull waits. */
          if (rows.length < 100) afterWake = wake;
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
        /** The request owns this loop even while the client holds no pending read. */
        const watch = async () => {
          try {
            while (!ended) {
              const wake = await checkWake();
              if (ended) return;
              const waiting = new AbortController();
              const waitingSignal = AbortSignal.any([signal, waiting.signal]);
              let heartbeat: boolean;
              try {
                heartbeat = await Promise.race([
                  notifications.wait(changes, wake, waitingSignal).then(() => false),
                  clock
                    .sleep(Math.min(10_000, lease - clock.currentTimeMillis()), waitingSignal)
                    .then(() => true),
                ]);
              } finally {
                waiting.abort(waitDone);
              }
              await checkWake();
              if (heartbeat && !ended) {
                await recheck(notifications.revision());
                await checkWake();
              }
              activity.resolve(heartbeat);
              activity = Promise.withResolvers();
            }
          } catch (error) {
            fail(error);
          }
        };
        const fail = (error: unknown) => {
          if (signal.aborted) {
            close();
            return;
          }
          ended = true;
          stop.abort(waitDone);
          activity.resolve(false);
          notifications.close(changes);
          output?.error(error);
        };
        /** Heartbeats are sent only for a pending pull; stalled clients buffer no heartbeat. */
        const greetOrWait = async (
          controller: ReadableStreamDefaultController<Uint8Array>,
          awake: Promise<boolean>,
        ) => {
          if (ended || notifications.revision() !== afterWake) return false;
          if (!greeted) {
            greeted = true;
            controller.enqueue(encoder.encode(": connected\n\n"));
            return true;
          }
          const heartbeat = await awake;
          await checkWake();
          if (heartbeat && !ended) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          return heartbeat;
        };
        return new ReadableStream<Uint8Array>(
          {
            start(controller) {
              output = controller;
              if (ended) controller.close();
              else watching = watch();
            },
            async pull(controller) {
              try {
                while (!ended) {
                  const awake = activity.promise;
                  const wake = await checkWake();
                  if (ended) return;
                  if (await replay(wake, controller)) return;
                  if (await greetOrWait(controller, awake)) return;
                }
              } catch (error) {
                fail(error);
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
