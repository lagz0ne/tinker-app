import { operation, extension, resource } from "@tinker/core";
import { tabStop } from "./owner.ts";
import { getBootstrap, getAccount } from "../sync.functions.ts";
import { syncClient, applyBootstrap } from "./sync.ts";
import { streamMessage } from "@/lib/tinker";
import { streamInput } from "../sync.ts";
import type { Sync } from "../sync.ts";
import type { Stream } from "../protocol.ts";
/** The network client is replaced only in scope tests. */
export const snapshotSource = resource({
  label: "sync.snapshotSource",
  factory: () => ({
    load: (options: { signal: AbortSignal }) => getBootstrap(options),
    account: (options: { signal: AbortSignal }) => getAccount(options),
  }),
});
/** One tab shares a load until account exit; auth holds reconnects until its new snapshot is applied. */
export const snapshotLoader = resource({
  label: "sync.snapshotLoader",
  depends: { sync: syncClient, apply: applyBootstrap, source: snapshotSource },
  factory: async ({ sync, apply, source }) => {
    let loadedVersion = -1;
    let loading: { version: number; promise: Promise<Sync.Snapshot> } | undefined;
    let changing: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    return {
      beginAccountChange() {
        changing = Promise.withResolvers<void>();
        return changing;
      },
      endAccountChange(change: ReturnType<typeof Promise.withResolvers<void>>) {
        if (changing === change) changing = undefined;
        change.resolve();
      },
      async completeAccountChange(
        signal: AbortSignal,
        change: ReturnType<typeof Promise.withResolvers<void>>,
      ) {
        try {
          const token = sync.capture();
          if (loadedVersion === token.version) return sync.snapshot();
          if (loading?.version === token.version) return loading.promise;
          const request = {
            version: token.version,
            promise: Promise.resolve().then(async () => {
              const snapshot = await source.load({ signal });
              const version = await apply.run({ rawInput: { snapshot, version: token.version } });
              if (version !== undefined) loadedVersion = version;
              return sync.snapshot();
            }),
          };
          loading = request;
          try {
            return await request.promise;
          } finally {
            if (loading === request) loading = undefined;
          }
        } finally {
          if (changing === change) changing = undefined;
          change.resolve();
        }
      },
      async ready() {
        await changing?.promise;
      },
      async account(signal: AbortSignal) {
        await changing?.promise;
        const accountId = await source.account({ signal });
        if (accountId !== sync.cursors().accountId) sync.leave();
        return accountId;
      },
      async load(signal: AbortSignal) {
        await changing?.promise;
        const token = sync.capture();
        if (loadedVersion === token.version) return sync.snapshot();
        if (loading?.version === token.version) return loading.promise;
        const request = {
          version: token.version,
          promise: Promise.resolve().then(async () => {
            const snapshot = await source.load({ signal });
            const version = await apply.run({ rawInput: { snapshot, version: token.version } });
            if (version !== undefined) loadedVersion = version;
            return sync.snapshot();
          }),
        };
        loading = request;
        try {
          return await request.promise;
        } finally {
          if (loading === request) loading = undefined;
        }
      },
    };
  },
});
export const loadSnapshot = operation({
  label: "sync.load",
  depends: { snapshots: snapshotLoader },
  run: ({ snapshots }, ctx) => snapshots.load(ctx.signal),
});
export const checkAccount = operation({
  label: "sync.checkAccount",
  depends: { snapshots: snapshotLoader },
  run: ({ snapshots }, ctx) => snapshots.account(ctx.signal),
});
/** Native framing stays in EventSource. Overflow discards unapplied frames and replays. */
const eventSource = resource({
  label: "sync.eventSource",
  factory: (_deps, ctx) => {
    let close: (() => void) | undefined;
    ctx.defer(() => close?.());
    let source: EventSource | undefined;
    let signal: AbortSignal | undefined;
    const queue: string[] = [];
    let ended = true;
    let waiting: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    return {
      connect(cursor: Stream.Cursor, stop: AbortSignal) {
        close?.();
        signal = stop;
        source = new EventSource(`/api/sync?cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
        ended = false;
        const connection = source;
        const connectionSignal = signal;
        const closeConnection = () => {
          if (ended) return;
          ended = true;
          connection.close();
          queue.length = 0;
          connectionSignal.removeEventListener("abort", closeConnection);
          waiting?.resolve();
        };
        close = closeConnection;
        const receive = (event: MessageEvent<string>) => {
          if (ended) return;
          if (queue.length >= 8) {
            closeConnection();
            return;
          }
          queue.push(event.data);
          waiting?.resolve();
        };
        source.addEventListener("changes", receive);
        source.addEventListener("account", receive);
        source.addEventListener("error", closeConnection);
        signal.addEventListener("abort", closeConnection, { once: true });
        if (signal.aborted) closeConnection();
      },
      close() {
        close?.();
      },
      async next() {
        while (!ended && queue.length === 0) {
          const received = Promise.withResolvers<void>();
          waiting = received;
          await received.promise;
          waiting = undefined;
        }
        return ended ? undefined : queue.shift();
      },
    };
  },
});
export const receiveMessage = operation({
  label: "sync.receive",
  input: (raw: unknown) => {
    const { version, data } = streamInput.parse(raw);
    return { version, message: streamMessage.parse(JSON.parse(data)) };
  },
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
  depends: {
    sync: syncClient,
    source: eventSource,
    receive: receiveMessage,
    snapshots: snapshotLoader,
  },
  run: async ({ sync, source, receive, snapshots }, ctx) => {
    await snapshots.ready();
    const token = sync.capture();
    const cursors = sync.cursors();
    source.connect(
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
        const data = await source.next();
        if (data === undefined) return false;
        const applied = await receive.settle({ rawInput: { data, version: token.version } });
        if (applied.status !== "success") return false;
        if (applied.value) return true;
      }
    } finally {
      source.close();
    }
  },
});
/** Connection refresh checks identity only; the same account keeps its applied event cursors. */
export const refreshAccount = operation({
  label: "sync.refreshAccount",
  depends: {
    sync: syncClient,
    load: loadSnapshot,
    source: snapshotSource,
    snapshots: snapshotLoader,
  },
  run: async ({ sync, load, source, snapshots }, ctx) => {
    await snapshots.ready();
    const version = sync.capture().version;
    const accountId = await source.account({ signal: ctx.signal });
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
