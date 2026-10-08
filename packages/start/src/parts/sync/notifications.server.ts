import { resource } from "@tinker/core";
import { database } from "#tinker/app.server";
import { raise } from "../../errors";
import type { Stream } from "./protocol";

const wheelStopped = Symbol("sync.wheelStopped");

/** One native listener wakes all request subscribers; reconnect replaces a broken listener. */
export const notifications = resource({
  label: "sync.notifications",
  depends: { database },
  factory: async ({ database }, { defer, clock }) => {
    let revision = 0;
    let broken = false;
    let connection:
      | Promise<
          | { kind: "connected"; close: () => void | Promise<void> }
          | { kind: "failed"; error: unknown }
        >
      | undefined;
    /** The listener connection, held wait, and timer slot owned by one request. */
    type Subscriber = {
      opened: NonNullable<typeof connection>;
      closed: boolean;
      disconnected: (() => void) | undefined;
      waiting: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
      bucket: Set<Subscriber> | undefined;
      deadline: number;
    };
    const watchers = new Set<Subscriber>();
    /** Ten one-second buckets retain each subscriber only until its next heartbeat or lease. */
    const wheel = new Map<number, Set<Subscriber>>();
    let scheduled = 0;
    let timer: AbortController | undefined;
    let ticking: Promise<void> | undefined;
    const unschedule = (subscriber: Subscriber) => {
      if (!subscriber.bucket) return;
      subscriber.bucket.delete(subscriber);
      subscriber.bucket = undefined;
      scheduled -= 1;
    };
    const resolveWait = (subscriber: Subscriber, heartbeat: boolean) => {
      const waiting = subscriber.waiting;
      subscriber.waiting = undefined;
      waiting?.resolve(heartbeat);
    };
    const nextDeadline = () => {
      let next = Infinity;
      for (const bucket of wheel.values())
        for (const subscriber of bucket) next = Math.min(next, subscriber.deadline);
      return next;
    };
    const expire = () => {
      const now = clock.currentTimeMillis();
      for (const bucket of wheel.values()) {
        for (const subscriber of bucket) {
          if (subscriber.deadline > now) continue;
          unschedule(subscriber);
          resolveWait(subscriber, true);
        }
      }
    };
    const failSleeps = (error: unknown) => {
      for (const bucket of wheel.values()) {
        for (const subscriber of bucket) {
          unschedule(subscriber);
          const waiting = subscriber.waiting;
          subscriber.waiting = undefined;
          waiting?.reject(error);
        }
      }
    };
    /** Exact deadlines avoid rounding a staggered stream's heartbeat or lease to a bucket edge. */
    const tick = async (stop: AbortController) => {
      try {
        while (scheduled && !stop.signal.aborted) {
          await clock.sleep(Math.max(0, nextDeadline() - clock.currentTimeMillis()), stop.signal);
          if (stop.signal.aborted) return;
          expire();
        }
      } catch (error) {
        if (!stop.signal.aborted) failSleeps(error);
      } finally {
        if (timer === stop) {
          timer = undefined;
          ticking = undefined;
        }
      }
    };
    const schedule = (subscriber: Subscriber, lease: number) => {
      unschedule(subscriber);
      subscriber.deadline = Math.min(clock.currentTimeMillis() + 10_000, lease);
      const slot = Math.floor(subscriber.deadline / 1000) % 10;
      let bucket = wheel.get(slot);
      if (!bucket) {
        bucket = new Set();
        wheel.set(slot, bucket);
      }
      bucket.add(subscriber);
      subscriber.bucket = bucket;
      scheduled += 1;
      if (!timer || timer.signal.aborted) {
        timer = new AbortController();
        ticking = tick(timer);
      }
    };
    /** Streams at the same cursor borrow one encoded frame per wake, as Go's singleflight does. */
    let reads = new Map<string, Promise<Stream.Frame>>();
    const wake = () => {
      revision += 1;
      reads = new Map();
      for (const subscriber of watchers) {
        if (broken || subscriber.opened !== connection) subscriber.disconnected?.();
        unschedule(subscriber);
        resolveWait(subscriber, false);
      }
    };
    const listenerFailed = () => {
      broken = true;
      wake();
    };
    defer(async () => {
      broken = true;
      wake();
      timer?.abort(wheelStopped);
      await ticking;
      const current = await connection;
      if (current?.kind === "connected") await current.close();
    });
    return {
      async subscribe(disconnected?: () => void) {
        if (!connection || broken) {
          const previous = connection;
          broken = false;
          connection = Promise.resolve().then(async () => {
            const old = await previous;
            if (old?.kind === "connected") await old.close();
            try {
              return {
                kind: "connected" as const,
                close: await database.listen(wake, listenerFailed),
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
      share(key: string, read: () => PromiseLike<Stream.Frame>) {
        const held = reads.get(key);
        if (held) return held;
        const at = reads;
        const started = Promise.resolve(read()).catch((error) => {
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
        unschedule(subscriber);
        resolveWait(subscriber, false);
        if (!scheduled) timer?.abort(wheelStopped);
      },
      wait(subscriber: Subscriber, after: number, lease?: number) {
        if (subscriber.closed || broken || after !== revision) return false;
        const changed = Promise.withResolvers<boolean>();
        subscriber.waiting = changed;
        if (lease !== undefined) schedule(subscriber, lease);
        return changed.promise;
      },
    };
  },
});
