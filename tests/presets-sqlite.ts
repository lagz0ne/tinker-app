import {
  syncSide,
  recordsSlot,
  readBatchSlot,
  readBootstrapSlot,
  readSnapshotSlot,
  streamMessageSlot,
} from "~/components/sync-sqlite";

import { readBatch, readBootstrap, readSnapshot, streamMessage } from "@/demo/contracts/sync";
import { records } from "@/demo/frontend/records";

/** The demo's client records and readers, bound to the SQLite sync copy's slots. */
export const clientBindings = [
  syncSide("tab"),
  recordsSlot(records),
  readBatchSlot(readBatch),
  readBootstrapSlot(readBootstrap),
  readSnapshotSlot(readSnapshot),
  streamMessageSlot(streamMessage),
];
