import { operation, resource } from "@tinker/core";
import { auth, database } from "#tinker/app.server";
import { requestHeaders } from "../../backend/headers.server";
import { backendStop, requestStop } from "../../backend/lifetime";
import { raise } from "../../errors";
import { drizzleOrm } from "../../modules.server";
import { notifications } from "./notifications.server";
import { event } from "./schema";
import { streamCursor, streamRequest } from "./protocol";
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

const encoder = new TextEncoder();

/** The frame a stream sends, then closes on, when its account signed out or changed. */
const accountChange = encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n');

/**
 * The request resource owns the returned body, including pulls after the opening operation ends.
 * The stream replays events after the cursor, greets once, then waits for a wake or a 10 s
 * heartbeat. A wake reads no account. A notice that names the stream's account makes it re-read
 * the account; it closes at a 30 s lease, on a broken listener, or on an account change.
 */
export const eventStream = resource({
  label: "sync.stream",
  target: "session",
  depends: {
    database,
    notifications,
    account: liveAccount,
    backendStop,
    requestStop,
    orm: drizzleOrm,
  },
  factory: async (
    { database, notifications, account, backendStop, requestStop, orm },
    { signal: cleanup, defer, clock },
  ) => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, backendStop, requestStop, cleanup]);
    let subscription: Awaited<ReturnType<typeof notifications.subscribe>> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let watching: Promise<void> | undefined;
    let activity: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
    const close = () => {
      if (ended) return;
      ended = true;
      stop.abort(waitDone);
      activity?.resolve(false);
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
        const expectedAccount = initial.private?.accountId ?? null;
        subscription = await notifications.subscribe(close, expectedAccount);
        if (signal.aborted) {
          notifications.close(subscription);
          raise("Cancelled", {});
        }
        const changes = subscription;
        const initialAccount = await account.run();
        if (initial.private && initial.private.accountId !== initialAccount)
          raise("StreamDenied", {});
        const { and, or, eq, gt, asc } = orm;
        const cursor = { ...initial, private: initial.private ? { ...initial.private } : null };
        const lease = clock.currentTimeMillis() + 30_000;
        /** A stream opened as another account, or with none, re-reads before its first frame. */
        if (initialAccount !== expectedAccount) changes.stale = true;
        let afterWake = -1;
        let greeted = false;
        let checking: Promise<number> | undefined;
        /** Re-read the account after a notice; a change sends its frame and closes the stream. */
        const recheck = (): Promise<number> =>
          (checking = account
            .run()
            .then((current) => {
              if (!ended && current !== expectedAccount) {
                output?.enqueue(accountChange.slice());
                close();
              }
              return notifications.revision();
            })
            .finally(() => {
              checking = undefined;
            }));
        /** The lease and the listener close the stream; a notice re-reads the account first. */
        const checkWake = (): number | Promise<number> => {
          if (notifications.ended(changes) || clock.currentTimeMillis() >= lease) {
            close();
            return notifications.revision();
          }
          if (checking) return checking;
          if (!changes.stale) return notifications.revision();
          changes.stale = false;
          return recheck();
        };
        /** A length-prefixed account ID keeps arbitrary account names in separate cache keys. */
        const readFrame = () => {
          const privateKey = cursor.private
            ? `${cursor.private.accountId.length}:${cursor.private.accountId}:${cursor.private.revision}`
            : "-";
          return notifications.share(`${cursor.public}:${privateKey}`, async () => {
            const next = {
              public: cursor.public,
              private: cursor.private ? { ...cursor.private } : null,
            };
            const rows = await database
              .select()
              .from(event)
              .where(
                or(
                  and(eq(event.stream, "public"), gt(event.revision, next.public)),
                  next.private
                    ? and(
                        eq(event.stream, next.private.accountId),
                        gt(event.revision, next.private.revision),
                      )
                    : undefined,
                ),
              )
              .orderBy(asc(event.stream), asc(event.revision))
              .limit(100);
            for (const row of rows) {
              if (row.stream === "public") next.public = row.revision;
              else if (next.private) next.private.revision = row.revision;
            }
            return {
              cursor: next,
              count: rows.length,
              bytes: rows.length
                ? encoder.encode(
                    `event: changes\nid: ${JSON.stringify(next)}\ndata: ${JSON.stringify({ kind: "changes", events: rows })}\n\n`,
                  )
                : new Uint8Array(),
            };
          });
        };
        /** The rows after the cursor, as one frame; false when there are none. */
        const replay = async (
          wake: number,
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) => {
          if (wake === afterWake) return false;
          const frame = await readFrame();
          await checkWake();
          if (ended) return true;
          if (!frame.count) {
            afterWake = wake;
            return false;
          }
          /** A short page has every row at this wake, so the next pull waits. */
          if (frame.count < 100) afterWake = wake;
          cursor.public = frame.cursor.public;
          if (cursor.private && frame.cursor.private)
            cursor.private.revision = frame.cursor.private.revision;
          controller.enqueue(frame.bytes.slice());
          return true;
        };
        /** The request owns this loop even while the client holds no pending read. */
        const watch = async () => {
          try {
            while (!ended) {
              const wake = await checkWake();
              if (ended) return;
              const heartbeat = await notifications.wait(changes, wake, lease);
              await checkWake();
              activity?.resolve(heartbeat);
              activity = undefined;
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
          activity?.resolve(false);
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
                  const awake = (activity ??= Promise.withResolvers<boolean>()).promise;
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

/** The raw HTTP request. Typed `input: { cursor }` skips this reader, so it has one raw shape. */
export const openSync = operation({
  label: "sync.open",
  input: (raw: unknown) => {
    const request = streamRequest.parse(raw);
    const supplied = request.lastEventId || new URLSearchParams(request.search).get("cursor");
    return {
      cursor: streamCursor.parse(supplied ? JSON.parse(supplied) : { public: 0, private: null }),
    };
  },
  depends: { stream: eventStream },
  run: async ({ stream }, { input }) => stream.open(input.cursor),
});
