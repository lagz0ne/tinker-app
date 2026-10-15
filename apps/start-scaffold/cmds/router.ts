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
import { telemetry, logConsole, telemetryService } from "~/components/telemetry";

const extensions: [] = [];
const router: RouterOptions = {};

export const getRouter = createRouterEntry({
  sync,
  telemetry,
  toolTags: [logConsole(console), telemetryService("tinker-browser")],
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
