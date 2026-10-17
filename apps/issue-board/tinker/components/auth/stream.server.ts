import { operation, resource } from "@tinker/core";
import type { Operation } from "@tinker/core";

import { database, drizzleOrm } from "~/components/database/index.server";
import { raise } from "~/components/errors";
import { backendStop, requestStop, startRequests } from "~/components/requests";
import { notifications, streamCursor, streamRequest, event } from "~/components/sync/index.server";
import type { Stream } from "~/components/sync/index.server";

import { liveAccount } from "./auth.server";

/** One replay page owns its database read and encoded bytes. */
const readFrame = operation({
  label: "sync.frame",
  depends: { database, orm: drizzleOrm },
  run: async (
    { database, orm },
    { input }: Operation.Ctx<Stream.Cursor>,
  ): Promise<Stream.Frame> => {
    const { and, or, eq, gt, asc } = orm;
    const next = { public: input.public, private: input.private ? { ...input.private } : null };
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

    const encoder = new TextEncoder();
    return {
      cursor: next,
      count: rows.length,
      bytes: rows.length
        ? encoder.encode(
            `event: changes\nid: ${JSON.stringify(next)}\ndata: ${JSON.stringify({ kind: "changes", events: rows })}\n\n`,
          )
        : new Uint8Array(),
    };
  },
});

/** The request owns one subscription, identity lease, and shared account recheck. */
const streamLease = resource({
  label: "sync.streamLease",
  target: "session",
  depends: { notifications, account: liveAccount.controller, backendStop, requestStop },
  factory: async (
    { notifications, account, backendStop, requestStop },
    { signal: cleanup, defer, clock },
  ) => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, backendStop, requestStop, cleanup]);
    const done = Symbol("sync.waitDone");
    let subscription: Awaited<ReturnType<typeof notifications.subscribe>> | undefined;
    let expectedAccount: string | null = null;
    let deadline = Infinity;
    let changed = false;
    let checking: Promise<number> | undefined;

    defer(() => lease.close());

    const lease = {
      signal,
      get changed() {
        return changed;
      },
      async open(initial: Stream.Cursor) {
        expectedAccount = initial.private?.accountId ?? null;
        subscription = await notifications.subscribe(stop.abort.bind(stop, done), expectedAccount);
        if (signal.aborted) {
          notifications.close(subscription);
          raise("Cancelled", {});
        }

        const current = await account.run();
        if (initial.private && initial.private.accountId !== current) raise("StreamDenied", {});
        deadline = clock.currentTimeMillis() + 30_000;
        if (current !== expectedAccount) subscription.stale = true;
      },
      async check(): Promise<number> {
        if (!subscription) raise("StreamDisconnected", {});
        if (notifications.ended(subscription) || clock.currentTimeMillis() >= deadline) {
          lease.close();
          return notifications.revision();
        }

        if (checking) return checking;
        if (!subscription.stale) return notifications.revision();
        subscription.stale = false;
        checking = account
          .run()
          .then((current) => {
            if (!signal.aborted && current !== expectedAccount) {
              changed = true;
              stop.abort(done);
            }
            return notifications.revision();
          })
          .finally(() => {
            checking = undefined;
          });
        return checking;
      },
      async wait(after: number) {
        await lease.check();
        if (signal.aborted) return false;
        if (!subscription) raise("StreamDisconnected", {});

        const heartbeat = await notifications.wait(subscription, after, deadline);
        await lease.check();
        return heartbeat;
      },
      revision() {
        return notifications.revision();
      },
      close() {
        if (subscription) notifications.close(subscription);
        stop.abort(done);
      },
    };
    return lease;
  },
});

type Read =
  | { kind: "ended" }
  | { kind: "idle"; wake: number }
  | { kind: "frame"; bytes: Uint8Array };

/** One request advances its cursor; cached frame values are never changed or handed to the body. */
const streamReader = resource({
  label: "sync.streamReader",
  target: "session",
  depends: { lease: streamLease, notifications, requests: startRequests },
  factory: async ({ lease, notifications, requests }) => {
    const frame = requests.scope.controller(readFrame);
    let cursor: Stream.Cursor = { public: 0, private: null };
    let afterWake = -1;
    return {
      async open(initial: Stream.Cursor) {
        await lease.open(initial);
        cursor = { ...initial, private: initial.private ? { ...initial.private } : null };
      },
      async read(): Promise<Read> {
        const wake = await lease.check();
        if (lease.signal.aborted) return { kind: "ended" };
        if (wake === afterWake) return { kind: "idle", wake };
        const privateKey = cursor.private
          ? `${cursor.private.accountId.length}:${cursor.private.accountId}:${cursor.private.revision}`
          : "-";
        const next = await notifications.share(
          `${cursor.public}:${privateKey}`,
          frame.settle.bind(frame),
          cursor,
        );
        await lease.check();
        if (lease.signal.aborted) return { kind: "ended" };

        if (!next.count) {
          afterWake = wake;
          return { kind: "idle", wake };
        }
        if (next.count < 100) afterWake = wake;
        cursor = next.cursor;
        return { kind: "frame", bytes: next.bytes.slice() };
      },
    };
  },
});

/** The request owns pulls and its independent watch loop, even when the client stops reading. */
export const eventStream = resource({
  label: "sync.stream",
  target: "session",
  depends: { lease: streamLease, reader: streamReader },
  factory: async ({ lease, reader }, { defer }) => {
    const encoder = new TextEncoder();
    const accountChange = encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n');
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let watching: Promise<void> | undefined;
    let activity = Promise.withResolvers<boolean>();

    const close = () => {
      if (ended) return;
      ended = true;
      activity.resolve(false);

      if (lease.changed) output?.enqueue(accountChange.slice());
      output?.close();
      lease.close();
    };

    lease.signal.addEventListener("abort", close, { once: true });
    defer(async () => {
      close();
      lease.signal.removeEventListener("abort", close);
      await watching;
    });

    return {
      async open(initial: Stream.Cursor) {
        await reader.open(initial);
        let greeted = false;
        return new ReadableStream<Uint8Array>(
          {
            start(controller) {
              output = controller;
              if (ended) {
                controller.close();
                return;
              }
              watching = Promise.resolve()
                .then(async () => {
                  while (!ended) {
                    const wake = await lease.check();
                    if (ended) return;
                    const heartbeat = await lease.wait(wake);

                    const waiting = activity;
                    activity = Promise.withResolvers<boolean>();
                    waiting.resolve(heartbeat);
                  }
                })
                .catch((error) => {
                  if (lease.signal.aborted) {
                    close();
                    return;
                  }
                  ended = true;
                  activity.resolve(false);
                  output?.error(error);
                  lease.close();
                });
            },
            pull(controller) {
              return Promise.resolve()
                .then(async () => {
                  while (!ended) {
                    const awake = activity.promise;
                    const frame = await reader.read();
                    if (frame.kind === "ended") return;
                    if (frame.kind === "frame") {
                      controller.enqueue(frame.bytes);
                      return;
                    }
                    if (lease.revision() !== frame.wake) continue;
                    if (!greeted) {
                      greeted = true;
                      controller.enqueue(encoder.encode(": connected\n\n"));
                      return;
                    }

                    const heartbeat = await awake;
                    await lease.check();
                    if (!heartbeat) continue;
                    if (!ended) controller.enqueue(encoder.encode(": heartbeat\n\n"));
                    return;
                  }
                })
                .catch((error) => {
                  if (lease.signal.aborted) {
                    close();
                    return;
                  }
                  ended = true;
                  activity.resolve(false);
                  output?.error(error);
                  lease.close();
                });
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

/** A reconnect cursor wins over the query cursor; both are checked before opening the body. */
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
