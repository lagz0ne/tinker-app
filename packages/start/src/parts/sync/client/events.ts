import { extension, operation, resource, tag } from "@tinker/core";
import { streamMessage } from "#tinker/app";
import { streamInput } from "../envelopes";
import type { Sync } from "../envelopes";
import { snapshotSource } from "../functions";
import type { Stream } from "../protocol";
import { applyBootstrap, syncClient } from "./sync";
import { tabStop } from "./tab";

/**
 * One tab shares a load per account version; a sign-in holds loads and reconnects until its new
 * snapshot is applied.
 */
export const snapshotLoader = resource({
  label: "sync.snapshotLoader",
  depends: { sync: syncClient, apply: applyBootstrap, source: snapshotSource },
  factory: async ({ sync, apply, source }) => {
    let loadedVersion = -1;
    let loading: { version: number; promise: Promise<Sync.Snapshot> } | undefined;
    let changing: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    /** The snapshot for the current version: applied, in flight, or loaded now. */
    const fetchSnapshot = async (signal: AbortSignal) => {
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
    };
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
          return await fetchSnapshot(signal);
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
        return fetchSnapshot(signal);
      },
    };
  },
});
export const loadSnapshot = operation({
  label: "sync.load",
  depends: { snapshots: snapshotLoader },
  run: ({ snapshots }, { signal }) => snapshots.load(signal),
});
export const checkAccount = operation({
  label: "sync.checkAccount",
  depends: { snapshots: snapshotLoader },
  run: ({ snapshots }, { signal }) => snapshots.account(signal),
});

/** What the tab's stream needs from an EventSource. */
type Source = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};
/** How a tab opens its stream: the native EventSource. Scope tests bind a fake. */
export const eventSourceBackend = tag<(url: string) => Source>({
  label: "sync.eventSourceBackend",
  default: (url) => new EventSource(url),
});

/**
 * One stream connection at a time. EventSource keeps the framing; frames queue until read, and
 * a ninth unread frame closes the connection, so the tab replays instead of lagging.
 */
export const eventSource = resource({
  label: "sync.eventSource",
  depends: { open: eventSourceBackend },
  factory: ({ open }, { defer }) => {
    let close: (() => void) | undefined;
    defer(() => close?.());
    const queue: string[] = [];
    let ended = true;
    let waiting: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    return {
      connect(cursor: Stream.Cursor, signal: AbortSignal) {
        close?.();
        const connection = open(`/api/sync?cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
        ended = false;
        const closeConnection = () => {
          if (ended) return;
          ended = true;
          connection.close();
          queue.length = 0;
          signal.removeEventListener("abort", closeConnection);
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
        connection.addEventListener("changes", receive);
        connection.addEventListener("account", receive);
        connection.addEventListener("error", closeConnection);
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

/** One frame: changes apply (false); an account change leaves the account (true). */
export const receiveMessage = operation({
  label: "sync.receive",
  input: (raw: unknown) => {
    const { version, data } = streamInput.parse(raw);
    return { version, message: streamMessage.parse(JSON.parse(data)) };
  },
  depends: { sync: syncClient },
  run: async ({ sync }, { input }) => {
    if (input.version !== sync.capture().version) return false;
    if (input.message.kind === "changes") {
      sync.apply(input.message.events, input.version);
      return false;
    }
    sync.leave();
    return true;
  },
});

/** One connection, from the applied cursors, until it ends (false) or the account changes (true). */
export const consumeConnection = operation({
  label: "sync.connection",
  depends: {
    sync: syncClient,
    source: eventSource,
    receive: receiveMessage,
    snapshots: snapshotLoader,
  },
  run: async ({ sync, source, receive, snapshots }, { signal }) => {
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
      AbortSignal.any([token.signal, signal]),
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
  run: async ({ sync, load, source, snapshots }, { signal }) => {
    await snapshots.ready();
    const version = sync.capture().version;
    const accountId = await source.account({ signal });
    if (version !== sync.capture().version) return;
    if (accountId !== sync.cursors().accountId) {
      sync.leave();
      await load.run();
    }
  },
});

/** Connect, read, then reload after an account change or re-check the account; 500 ms apart. */
export const streamChanges = operation({
  label: "sync.listen",
  depends: { consume: consumeConnection, load: loadSnapshot, refresh: refreshAccount },
  run: async ({ consume, load, refresh }, { signal, log, clock }) => {
    while (!signal.aborted) {
      const consumed = await consume.settle();
      if (consumed.status === "failed") log("sync.reconnecting");
      if (signal.aborted) return;
      const loaded =
        consumed.status === "success" && consumed.value
          ? await load.settle()
          : await refresh.settle();
      if (loaded.status === "failed") log("sync.reconnecting");
      await clock.sleep(500, signal);
    }
  },
});

/** The tab's stream: `start` runs it once, until the tab stops. */
export const syncStreaming = extension({
  label: "sync.streaming",
  hooks: {
    async start({ next, scope, defer }) {
      await next();
      let started = false;
      return {
        start() {
          if (started) return;
          started = true;
          const running = scope.settle(streamChanges, { signal: scope.resolve(tabStop) });
          defer(async () => {
            const result = await running;
            if (result.status === "failed") throw result.error;
          });
        },
      };
    },
  },
});
