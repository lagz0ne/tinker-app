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
          { kind: "connected"; close: () => Promise<void> } | { kind: "failed"; error: unknown }
        >
      | undefined;
    const watchers = new Set<() => void>();
    const wake = () => {
      revision += 1;
      for (const notify of watchers) notify();
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
          connection = (async () => {
            const old = await previous;
            if (old?.kind === "connected") await old.close();
            try {
              return {
                kind: "connected" as const,
                close: await database.listen(wake, () => {
                  broken = true;
                  wake();
                }),
              };
            } catch (error) {
              broken = true;
              return { kind: "failed" as const, error };
            }
          })();
        }
        const opened = connection;
        const connected = await opened;
        if (connected.kind === "failed") throw connected.error;
        if (broken || opened !== connection) raise("StreamDisconnected", {});
        let closed = false;
        let waiting: (() => void) | undefined;
        const notify = () => {
          if (broken || opened !== connection) disconnected?.();
          waiting?.();
        };
        watchers.add(notify);
        return {
          revision: () => revision,
          ended: () => closed || broken || opened !== connection,
          close() {
            closed = true;
            watchers.delete(notify);
            waiting?.();
          },
          async wait(after: number, signal: AbortSignal) {
            if (closed || broken || after !== revision || signal.aborted) return;
            const changed = Promise.withResolvers<void>();
            waiting = () => changed.resolve();
            signal.addEventListener("abort", notify, { once: true });
            try {
              await changed.promise;
            } finally {
              signal.removeEventListener("abort", notify);
              waiting = undefined;
            }
          },
        };
      },
    };
  },
});
