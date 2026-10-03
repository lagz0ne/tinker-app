import { resource } from "@tinker/core";
import { database } from "@/lib/tinker.server";
import { raise } from "../errors.ts";
/** One native listener wakes all request subscribers; reconnect replaces a broken listener. */
export const notifications = resource({
  label: "sync.notifications",
  depends: { database },
  factory: async ({ database }, ctx) => {
    let revision = 0;
    let broken = false;
    let connection:
      | Promise<
          | { kind: "connected"; close: () => void | Promise<void> }
          | { kind: "failed"; error: unknown }
        >
      | undefined;
    const watchers = new Set<{
      opened: NonNullable<typeof connection>;
      closed: boolean;
      disconnected?: () => void;
      waiting?: ReturnType<typeof Promise.withResolvers<void>>;
    }>();
    const wake = () => {
      revision += 1;
      for (const subscriber of watchers) {
        if (broken || subscriber.opened !== connection) subscriber.disconnected?.();
        subscriber.waiting?.resolve();
      }
    };
    const listenerFailed = () => {
      broken = true;
      wake();
    };
    ctx.defer(async () => {
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
        const subscriber = { opened, closed: false, disconnected };
        watchers.add(subscriber);
        return subscriber;
      },
      revision() {
        return revision;
      },
      ended(subscriber: { opened: NonNullable<typeof connection>; closed: boolean }) {
        return subscriber.closed || broken || subscriber.opened !== connection;
      },
      close(subscriber: {
        opened: NonNullable<typeof connection>;
        closed: boolean;
        waiting?: ReturnType<typeof Promise.withResolvers<void>>;
        disconnected?: () => void;
      }) {
        subscriber.closed = true;
        watchers.delete(subscriber);
        subscriber.waiting?.resolve();
      },
      async wait(
        subscriber: {
          opened: NonNullable<typeof connection>;
          closed: boolean;
          waiting?: ReturnType<typeof Promise.withResolvers<void>>;
        },
        after: number,
        signal: AbortSignal,
      ) {
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
