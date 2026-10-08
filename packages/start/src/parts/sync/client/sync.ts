import { operation, resource } from "@tinker/core";
import { readBatch, readBootstrap, records } from "#tinker/app";
import { fail, raise } from "../../../errors";
import type { Sync } from "../envelopes";
import { accountOwner } from "./owner";

/**
 * The tab's applied state: the cursor per stream, and the account it belongs to. It keeps only
 * unfinished local writes, including results that arrive before their receipts.
 */
export const syncClient = resource({
  label: "sync.client",
  depends: { owner: accountOwner, records },
  factory: ({ owner, records: appRecords }, { defer, log, clock }) => {
    const records: Sync.Records = appRecords;
    let accountId: string | null = null;
    const cursors = new Map<string, number>();
    cursors.set("public", -1);
    const local = new Set<string>();
    const results = new Map<string, Sync.Result>();
    const waiters = new Map<string, ReturnType<typeof Promise.withResolvers<Sync.Result>>>();
    defer(() => {
      for (const waiting of waiters.values()) waiting.reject(fail("Cancelled", {}));
      waiters.clear();
      results.clear();
      local.clear();
    });
    const client = {
      capture: owner.capture,
      cursors: () => ({
        accountId,
        publicRevision: cursors.get("public") ?? -1,
        privateRevision: accountId === null ? -1 : (cursors.get(accountId) ?? -1),
      }),
      snapshot: () =>
        records.snapshot(
          cursors.get("public") ?? -1,
          accountId === null ? -1 : (cursors.get(accountId) ?? -1),
        ),
      leave() {
        owner.reset();
        if (accountId !== null) cursors.delete(accountId);
        accountId = null;
        records.resetPrivate();
        for (const waiting of waiters.values()) waiting.reject(fail("Cancelled", {}));
        waiters.clear();
        results.clear();
        local.clear();
      },
      bootstrap(snapshot: Sync.Snapshot, version: number) {
        if (version !== owner.capture().version) return;
        const nextId = snapshot.private?.stream ?? null;
        if (nextId !== accountId) client.leave();
        if (local.size > 0) return;
        accountId = nextId;
        client.merge(snapshot);
        return owner.capture().version;
      },
      merge(snapshot: Sync.Snapshot) {
        const publicRevision = cursors.get("public") ?? -1;
        records.bootstrapPublic(snapshot.public, publicRevision);
        cursors.set("public", Math.max(publicRevision, snapshot.public.revision));
        if (snapshot.private) {
          const privateRevision = cursors.get(snapshot.private.stream) ?? -1;
          records.bootstrapPrivate(snapshot.private, privateRevision);
          cursors.set(
            snapshot.private.stream,
            Math.max(privateRevision, snapshot.private.revision),
          );
        }
      },
      finish(executionId: string, result: Sync.Result) {
        if (!local.has(executionId)) return;
        results.set(executionId, result);
        waiters.get(executionId)?.resolve(result);
      },
      apply(events: Sync.Event[], version: number) {
        if (version !== owner.capture().version) return;
        for (const event of events) {
          const previous = cursors.get(event.stream);
          if (previous === undefined || event.revision <= previous) continue;
          if (event.revision !== previous + 1) break;
          if (event.payload.kind === "change") records.change(event.payload.change);
          else client.finish(event.executionId, event.payload.result);
          cursors.set(event.stream, event.revision);
        }
      },
      async wait(executionId: string, version: number, signal: AbortSignal): Promise<Sync.Result> {
        if (version !== owner.capture().version || signal.aborted) raise("Cancelled", {});
        const completed = results.get(executionId);
        if (completed) return completed;
        const waiting = Promise.withResolvers<Sync.Result>();
        waiters.set(executionId, waiting);
        const stop = () => waiting.reject(fail("Cancelled", {}));
        signal.addEventListener("abort", stop, { once: true });
        try {
          return await waiting.promise;
        } finally {
          signal.removeEventListener("abort", stop);
          waiters.delete(executionId);
        }
      },
      /**
       * Send a write and wait for its result event. A send that throws is retried after 500 ms;
       * a rejected reply fails the write; an account exit or the call's signal cancels it.
       */
      async execute<T>(
        executionId: string,
        request: {
          data: T;
          send: (options: { data: T; signal: AbortSignal }) => Promise<Sync.Reply>;
        },
        callSignal: AbortSignal,
      ): Promise<Sync.Result> {
        const token = owner.capture();
        const signal = AbortSignal.any([token.signal, callSignal]);
        local.add(executionId);
        try {
          for (;;) {
            if (signal.aborted) raise("Cancelled", {});
            let reply: Sync.Reply;
            try {
              reply = await request.send({ data: request.data, signal });
            } catch (error) {
              if (signal.aborted) throw error;
              log("sync.reconnecting");
              await clock.sleep(500, signal);
              continue;
            }
            if (reply.kind === "rejected") raise("WriteRejected", { message: reply.message });
            const result = await client.wait(executionId, token.version, signal);
            if (signal.aborted) raise("Cancelled", {});
            return result;
          }
        } finally {
          local.delete(executionId);
          results.delete(executionId);
        }
      },
    };
    return client;
  },
});

export const applyBootstrap = operation({
  label: "sync.bootstrap",
  input: readBootstrap,
  depends: { sync: syncClient },
  run: async ({ sync }, { input }) => sync.bootstrap(input.snapshot, input.version),
});

export const applyEvents = operation({
  label: "sync.apply",
  input: readBatch,
  depends: { sync: syncClient },
  run: async ({ sync }, { input }) => sync.apply(input.events, input.version),
});

export const leaveAccount = operation({
  label: "sync.leave",
  depends: { sync: syncClient },
  run: async ({ sync }) => sync.leave(),
});
