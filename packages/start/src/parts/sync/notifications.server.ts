import { resource } from "@tinker/core";
import { database } from "#tinker/app.server";
import { raise } from "../../errors";
import type { event } from "./schema";

/** One native listener wakes all request subscribers; reconnect replaces a broken listener. */
export const notifications = resource({
  label: "sync.notifications",
  depends: { database },
  factory: async ({ database }, { defer }) => {
    let revision = 0;
    let broken = false;
    let connection:
      | Promise<
          | { kind: "connected"; close: () => void | Promise<void> }
          | { kind: "failed"; error: unknown }
        >
      | undefined;
    /** One stream's place on the listener: the connection it opened on, and its held wait. */
    type Subscriber = {
      opened: NonNullable<typeof connection>;
      closed: boolean;
      disconnected?: () => void;
      waiting?: ReturnType<typeof Promise.withResolvers<void>>;
    };
    const watchers = new Set<Subscriber>();
    /** Streams at the same cursor borrow one page per wake, as Go's singleflight does. */
    let reads = new Map<string, Promise<(typeof event.$inferSelect)[]>>();
    const wake = () => {
      revision += 1;
      reads = new Map();
      for (const subscriber of watchers) {
        if (broken || subscriber.opened !== connection) subscriber.disconnected?.();
        subscriber.waiting?.resolve();
      }
    };
    const listenerFailed = () => {
      broken = true;
      wake();
    };
    defer(async () => {
      broken = true;
      wake();
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
        const subscriber: Subscriber = { opened, closed: false, disconnected };
        watchers.add(subscriber);
        return subscriber;
      },
      revision() {
        return revision;
      },
      share(key: string, read: () => PromiseLike<(typeof event.$inferSelect)[]>) {
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
        subscriber.waiting?.resolve();
      },
      async wait(subscriber: Subscriber, after: number, signal: AbortSignal) {
        if (subscriber.closed || broken || after !== revision || signal.aborted) return;
        const changed = Promise.withResolvers<void>();
        subscriber.waiting = changed;
        const notify = () => changed.resolve();
        signal.addEventListener("abort", notify, { once: true });
        try {
          await changed.promise;
        } finally {
          signal.removeEventListener("abort", notify);
          subscriber.waiting = undefined;
        }
      },
    };
  },
});
