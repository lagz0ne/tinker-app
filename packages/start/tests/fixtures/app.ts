import { data, resource } from "@tinker/core";
import type { Many, Scope } from "@tinker/core";
import { z } from "zod";
import {
  batchEnvelope,
  bootstrapEnvelope,
  eventEnvelope,
  snapshotEnvelope,
} from "../../src/parts/sync/envelopes";
import type { Sync } from "../../src/parts/sync/envelopes";

/**
 * A stand-in client seam for the base's own tests and type check, as `#tinker/app`: the names
 * the sync part reads. Its records keep each snapshot part and each applied change in cells.
 */
export const extensions: Many<Scope.Extension<unknown>> = [];
export const savedPublic = data<Sync.Public | null>({ label: "test.public", initial: null });
export const savedPrivate = data<Sync.Private | null>({ label: "test.private", initial: null });
export const applied = data<unknown[]>({ label: "test.applied", initial: [] });

export const records = resource({
  label: "test.records",
  depends: {
    publicCell: savedPublic.controller,
    privateCell: savedPrivate.controller,
    changes: applied.controller,
  },
  factory: ({ publicCell, privateCell, changes }) => ({
    resetPrivate() {
      privateCell.set(null);
    },
    bootstrapPublic(value: Sync.Public, after: number) {
      if (value.revision >= after) publicCell.set(value);
    },
    bootstrapPrivate(value: Sync.Private, after: number) {
      if (value.revision >= after) privateCell.set(value);
    },
    change(change: Sync.Change) {
      changes.set([...changes.get(), change]);
    },
    snapshot(publicRevision: number, privateRevision: number): Sync.Snapshot {
      const saved = privateCell.get();
      return {
        public: { stream: "public", revision: Math.max(0, publicRevision) },
        private: saved === null ? null : { ...saved, revision: Math.max(0, privateRevision) },
      };
    },
  }),
});

export const readSnapshot = snapshotEnvelope;
export const readBootstrap = bootstrapEnvelope;
export const readBatch = batchEnvelope;

export const streamMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes"), events: z.array(eventEnvelope).max(100) }),
  z.object({ kind: z.literal("account-change") }),
]);
