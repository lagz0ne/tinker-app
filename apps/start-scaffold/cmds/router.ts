import { createRouterEntry } from "~/base/router-entry";
import type { RouterOptions } from "~/base/router-entry";
import { records, readBatch, readBootstrap, readSnapshot, streamMessage } from "~/components/demo";
import {
  sync,
  recordsSlot,
  readBatchSlot,
  readBootstrapSlot,
  readSnapshotSlot,
  streamMessageSlot,
} from "~/components/sync";
import { telemetry, logConsole } from "~/components/telemetry";

export const extensions = [];
export const router: RouterOptions = {};

export const getRouter = createRouterEntry({
  sync,
  telemetry,
  toolTags: [logConsole(console)],
  tags: [
    recordsSlot(records),
    readBatchSlot(readBatch),
    readBootstrapSlot(readBootstrap),
    readSnapshotSlot(readSnapshot),
    streamMessageSlot(streamMessage),
  ],
  extensions,
  router,
});
