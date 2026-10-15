import { extension, tag } from "@tinker/core";
import type { Operation, Resource } from "@tinker/core";

import type { Sync } from "~/components/sync/envelopes";

/** Each command supplies exactly one app value per slot. */
export const bootstrapSlot = tag<Operation.Handle<Sync.Snapshot | Promise<Sync.Snapshot>, void>>({
  label: "sync.bootstrap",
});

export const readAccountSlot = tag<Operation.Handle<string | null | Promise<string | null>, void>>({
  label: "sync.readAccount",
});

export const recordsSlot = tag<Resource.Handle<Sync.Records | Promise<Sync.Records>>>({
  label: "sync.records",
});

export const readBatchSlot = tag<{
  parse(raw: unknown): { version: number; events: Sync.Event[] };
}>({ label: "sync.readBatch" });

export const readBootstrapSlot = tag<{
  parse(raw: unknown): { version: number; snapshot: Sync.Snapshot };
}>({ label: "sync.readBootstrap" });

export const readSnapshotSlot = tag<{ parse(raw: unknown): Sync.Snapshot }>({
  label: "sync.readSnapshot",
});

export const streamMessageSlot = tag<{
  parse(raw: unknown): { kind: "changes"; events: Sync.Event[] } | { kind: "account-change" };
}>({ label: "sync.streamMessage" });

/** Resolve the app's record resource on its own root before client work starts. */
export const syncRecords = extension({
  label: "sync.records",
  hooks: {
    async start({ resolve, next }) {
      const source = resolve(recordsSlot);
      const records = await resolve(source);
      await next();
      return records;
    },
  },
});
