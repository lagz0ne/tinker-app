import { extension, tag } from "@tinker/core";
import type { Operation, Resource } from "@tinker/core";
import { z } from "zod";

import { tabStop } from "~/components/sync/client/tab";
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

/** The command names the component's host; there is no implicit role or config. */
export const syncSide = tag<"server" | "tab">({
  label: "sync.side",
  parse: z.enum(["server", "tab"]),
});

/** Check each host's required slots and load tab records before app.ready succeeds. */
export const syncStartup = extension({
  label: "sync.startup",
  hooks: {
    async start({ resolve, next }) {
      if (resolve(syncSide) === "server") {
        resolve(bootstrapSlot);
        resolve(readAccountSlot);
        await next();
        return;
      }
      resolve(tabStop);
      resolve(readBatchSlot);
      resolve(readBootstrapSlot);
      resolve(readSnapshotSlot);
      resolve(streamMessageSlot);

      const records = await resolve(resolve(recordsSlot));
      await next();
      return records;
    },
  },
});
