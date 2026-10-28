import { resource } from "@tinker/core";
import type { RunResult } from "@tinker/core";

import { database } from "~/components/database-sqlite/index.server";
import { raise } from "~/components/errors";
import { readResult } from "~/components/requests/index.server";
import { accountNotice } from "~/components/sync-sqlite/notice";
import type { Stream } from "~/components/sync-sqlite/protocol";

type TimedWait = {
  waiting: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
  bucket: Set<TimedWait> | undefined;
  deadline: number;
};

/** One clock loop owns the shared deadlines; closing its scope aborts and joins that loop. */
const notificationWheel = resource({
  label: "sync.notificationWheel",
  factory: (_deps, { defer, clock }) => {
    const stopped = Symbol("sync.wheelStopped");
    const buckets = new Map<number, Set<TimedWait>>();
    let scheduled = 0;
    let timer: AbortController | undefined;
    let ticking: Promise<void> | undefined;

    defer(async () => {
      timer?.abort(stopped);
      await ticking;
    });

    const wheel = {
      remove(subscriber: TimedWait, stopWhenIdle = false) {
        if (subscriber.bucket) {
          subscriber.bucket.delete(subscriber);
          subscriber.bucket = undefined;
          scheduled -= 1;
        }

        if (stopWhenIdle && !scheduled) timer?.abort(stopped);
      },
      schedule(subscriber: TimedWait, lease: number) {
        wheel.remove(subscriber);
        subscriber.deadline = Math.min(clock.currentTimeMillis() + 10_000, lease);
        const slot = Math.floor(subscriber.deadline / 1000) % 10;
        const bucket = buckets.get(slot) ?? new Set<TimedWait>();
        buckets.set(slot, bucket);
        bucket.add(subscriber);
        subscriber.bucket = bucket;
        scheduled += 1;

        if (timer && !timer.signal.aborted) return;
        timer = new AbortController();
        const stop = timer;
        // Start the first sleep now: subscribers observe one shared pending wait immediately.
        const first = clock.sleep(
          Math.max(
            0,
            Array.from(buckets.values()).reduce((next, held) => {
              for (const entry of held) next = Math.min(next, entry.deadline);
              return next;
            }, Infinity) - clock.currentTimeMillis(),
          ),
          stop.signal,
        );
        ticking = first
          .then(async () => {
            while (scheduled && !stop.signal.aborted) {
              const now = clock.currentTimeMillis();
              buckets.forEach((held) =>
                held.forEach((entry) => {
                  if (entry.deadline > now) return;
                  wheel.remove(entry);
                  const waiting = entry.waiting;
                  entry.waiting = undefined;
                  waiting?.resolve(true);
                }),
              );

              if (!scheduled) {
                if (timer === stop) {
                  timer = undefined;
                  ticking = undefined;
                }
                return;
              }
              await clock.sleep(
                Math.max(
                  0,
                  Array.from(buckets.values()).reduce((next, held) => {
                    for (const entry of held) next = Math.min(next, entry.deadline);
                    return next;
                  }, Infinity) - clock.currentTimeMillis(),
                ),
                stop.signal,
              );
            }
          })
          .catch((error) => {
            if (stop.signal.aborted) return;
            buckets.forEach((held) =>
              held.forEach((entry) => {
                wheel.remove(entry);
                const waiting = entry.waiting;
                entry.waiting = undefined;
                waiting?.reject(error);
              }),
            );
            if (timer === stop) {
              timer = undefined;
              ticking = undefined;
            }
          })
          .finally(() => {
            if (timer !== stop) return;
            timer = undefined;
            ticking = undefined;
          });
      },
    };
    return wheel;
  },
});

/** One native listener wakes all request subscribers; reconnect replaces a broken listener. */
export const notifications = resource({
  label: "sync.notifications",
  depends: { database, wheel: notificationWheel },
  factory: async ({ database, wheel }, { defer }) => {
    const accountPrefix = accountNotice("");

    let revision = 0;
    let broken = false;
    let connection:
      | Promise<
          | { kind: "connected"; close: () => void | Promise<void> }
          | { kind: "failed"; error: unknown }
        >
      | undefined;

    /** The listener connection, held wait, and timer slot owned by one request. */
    type Subscriber = TimedWait & {
      opened: NonNullable<typeof connection>;
      closed: boolean;
      /** The account whose notices reach this stream; null for a stream with no account. */
      accountId: string | null;
      /** Set by a notice: the stream re-reads its account before it sends another frame. */
      stale: boolean;
      disconnected: (() => void) | undefined;
    };
    const watchers = new Set<Subscriber>();

    /** Streams at the same cursor borrow one encoded frame per wake, as Go's singleflight does. */
    let reads = new Map<string, Promise<Stream.Frame>>();

    /** A saved change wakes every stream; a notice names one account. */
    const heard = (payload: string) => {
      const accountId = payload.startsWith(accountPrefix)
        ? payload.slice(accountPrefix.length)
        : null;
      if (accountId === null) {
        revision += 1;
        reads = new Map();
      }
      watchers.forEach((subscriber) => {
        if (accountId !== null && subscriber.accountId !== accountId) return;
        if (accountId !== null) subscriber.stale = true;
        else if (broken || subscriber.opened !== connection) subscriber.disconnected?.();

        wheel.remove(subscriber);
        const waiting = subscriber.waiting;
        subscriber.waiting = undefined;
        waiting?.resolve(false);
      });
    };

    const listenerFailed = () => {
      broken = true;
      heard("");
    };

    defer(async () => {
      broken = true;
      heard("");
      const current = await connection;
      if (current?.kind === "connected") await current.close();
    });

    return {
      async subscribe(disconnected?: () => void, accountId: string | null = null) {
        if (!connection || broken) {
          const previous = connection;
          broken = false;
          connection = Promise.resolve().then(async () => {
            const old = await previous;
            if (old?.kind === "connected") await old.close();
            try {
              return {
                kind: "connected" as const,
                close: await database.listen("start_sync", heard, listenerFailed),
              };
            } catch (error) {
              broken = true;
              return { kind: "failed" as const, error };
            }
          });
        }

        const opened = connection;
        const connected = await opened;
        if (connected.kind === "failed") throw connected.error;
        if (broken || opened !== connection) raise("StreamDisconnected", {});

        const subscriber: Subscriber = {
          opened,
          closed: false,
          accountId,
          stale: false,
          disconnected,
          waiting: undefined,
          bucket: undefined,
          deadline: Infinity,
        };
        watchers.add(subscriber);
        return subscriber;
      },
      revision() {
        return revision;
      },
      share(
        key: string,
        read: (call: { input: Stream.Cursor }) => PromiseLike<RunResult<Stream.Frame>>,
        cursor: Stream.Cursor,
      ) {
        const held = reads.get(key);
        if (held) return held;

        const at = reads;
        const started = Promise.resolve(read({ input: cursor }))
          .then(readResult)
          .catch((error) => {
            at.delete(key);
            throw error;
          });
        at.set(key, started);
        return started;
      },
      ended(subscriber: Subscriber) {
        return subscriber.closed || broken || subscriber.opened !== connection;
      },
      close(subscriber: Subscriber) {
        subscriber.closed = true;
        watchers.delete(subscriber);
        if (!watchers.size) reads.clear();

        wheel.remove(subscriber, true);
        const waiting = subscriber.waiting;
        subscriber.waiting = undefined;
        waiting?.resolve(false);
      },
      wait(subscriber: Subscriber, after: number, lease?: number) {
        if (subscriber.closed || broken || subscriber.stale || after !== revision) return false;
        const changed = Promise.withResolvers<boolean>();
        subscriber.waiting = changed;
        if (lease !== undefined) wheel.schedule(subscriber, lease);
        return changed.promise;
      },
    };
  },
});
