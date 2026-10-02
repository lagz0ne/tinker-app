import { operation, extension, resource } from "@tinker/core";
import { tabStop } from "./owner.ts";
import { getBootstrap, getAccount } from "../sync.functions.ts";
import { syncClient, applyBootstrap } from "./sync.ts";
import { readStreamMessage } from "@/lib/tinker";
import type { Stream } from "../protocol.ts";
export const loadSnapshot = operation({
  label: "sync.load",
  depends: { sync: syncClient, apply: applyBootstrap },
  run: async ({ sync, apply }, ctx) => {
    const token = sync.capture();
    const snapshot = await getBootstrap({ signal: ctx.signal });
    await apply.run({ rawInput: { snapshot, version: token.version } });
    return snapshot;
  },
});
/** Native framing stays in EventSource. Overflow discards unapplied frames and replays. */
const eventSource = resource({
  label: "sync.eventSource",
  factory: (_deps, ctx) => {
    let close = () => {};
    ctx.defer(() => close());
    return {
      connect(cursor: Stream.Cursor, signal: AbortSignal) {
        close();
        const source = new EventSource(
          `/api/sync?cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
        );
        const queue: string[] = [];
        let ended = false;
        let waiting: (() => void) | undefined;
        close = () => {
          if (ended) return;
          ended = true;
          source.close();
          queue.length = 0;
          signal.removeEventListener("abort", closeConnection);
          waiting?.();
        };
        const closeConnection = close;
        const receive = (event: MessageEvent<string>) => {
          if (ended) return;
          if (queue.length >= 8) {
            closeConnection();
            return;
          }
          queue.push(event.data);
          waiting?.();
        };
        source.addEventListener("changes", receive);
        source.addEventListener("account", receive);
        source.addEventListener("error", closeConnection);
        signal.addEventListener("abort", closeConnection, { once: true });
        if (signal.aborted) closeConnection();
        return {
          close: closeConnection,
          async next() {
            while (!ended && queue.length === 0) {
              const received = Promise.withResolvers<void>();
              waiting = () => received.resolve();
              await received.promise;
              waiting = undefined;
            }
            return ended ? undefined : queue.shift();
          },
        };
      },
    };
  },
});
export const receiveMessage = operation({
  label: "sync.receive",
  input: readStreamMessage,
  depends: { sync: syncClient },
  run: async ({ sync }, ctx) => {
    if (ctx.input.version !== sync.capture().version) return false;
    if (ctx.input.message.kind === "changes") {
      sync.apply(ctx.input.message.events, ctx.input.version);
      return false;
    }
    sync.leave();
    return true;
  },
});
const consumeConnection = operation({
  label: "sync.connection",
  depends: { sync: syncClient, source: eventSource, receive: receiveMessage },
  run: async ({ sync, source, receive }, ctx) => {
    const token = sync.capture();
    const cursors = sync.cursors();
    const connection = source.connect(
      {
        public: Math.max(0, cursors.publicRevision),
        private:
          cursors.accountId === null
            ? null
            : { accountId: cursors.accountId, revision: Math.max(0, cursors.privateRevision) },
      },
      AbortSignal.any([token.signal, ctx.signal]),
    );
    try {
      for (;;) {
        const data = await connection.next();
        if (data === undefined) return false;
        const applied = await receive.settle({ rawInput: { data, version: token.version } });
        if (applied.status !== "success") return false;
        if (applied.value) return true;
      }
    } finally {
      connection.close();
    }
  },
});
/** Connection refresh checks identity only; the same account keeps its applied event cursors. */
const refreshAccount = operation({
  label: "sync.refreshAccount",
  depends: { sync: syncClient, load: loadSnapshot },
  run: async ({ sync, load }, ctx) => {
    const version = sync.capture().version;
    const accountId = await getAccount({ signal: ctx.signal });
    if (version !== sync.capture().version) return;
    if (accountId !== sync.cursors().accountId) {
      sync.leave();
      await load.run();
    }
  },
});
const streamChanges = operation({
  label: "sync.listen",
  depends: { consume: consumeConnection, load: loadSnapshot, refresh: refreshAccount },
  run: async ({ consume, load, refresh }, ctx) => {
    while (!ctx.signal.aborted) {
      const consumed = await consume.settle();
      if (consumed.status === "failed") ctx.log("sync.reconnecting");
      if (ctx.signal.aborted) return;
      const loaded =
        consumed.status === "success" && consumed.value
          ? await load.settle()
          : await refresh.settle();
      if (loaded.status === "failed") ctx.log("sync.reconnecting");
      await ctx.clock.sleep(500, ctx.signal);
    }
  },
});
export const syncStreaming = extension({
  label: "sync.streaming",
  hooks: {
    async start(event) {
      await event.next();
      let started = false;
      return {
        start() {
          if (started) return;
          started = true;
          const running = event.scope.settle(streamChanges, {
            signal: event.scope.resolve(tabStop),
          });
          event.defer(async () => {
            const result = await running;
            if (result.status === "failed") throw result.error;
          });
        },
      };
    },
  },
});
