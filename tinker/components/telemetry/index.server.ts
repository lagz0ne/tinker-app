import { capsule } from "@tinker/core";

import { routes } from "~/components/requests/index.server";

import { consoleOutput } from "./console";
import { telemetryOrigin, telemetryRoute } from "./ingest.server";
import { queueSend, queueSink } from "./observer";
import { quiet } from "./records";
import {
  logLevel,
  logsUrl,
  spanHistory,
  telemetryService,
  telemetrySide,
  tracesUrl,
} from "./settings";
import { telemetryWorker, threadRoute, threadSink } from "./thread.server";

export type { Telemetry } from "./records";
export { exportHealth } from "./health";

export type { ThreadSettings, ThreadMessage, ThreadRing, ThreadWorker } from "./thread.server";
export { threadDrain } from "./drain.server";

const sends = {
  service: telemetryService.required,
  tracesUrl: tracesUrl.required,
  logsUrl: logsUrl.required,
  console: consoleOutput,
} as const;

const records = { level: logLevel, history: spanHistory, origin: telemetryOrigin } as const;

/**
 * The server's telemetry. Each is the sink of its own root: list it first, so it closes last.
 * `server` sends on this thread (dev, tests, the worker itself); `thread` sends from a worker.
 * `route` takes the tab's batches; mount it in the route table. It runs quiet (`routes.ns`):
 * taking a batch makes no span or log line, so a sink never traces its own ingest.
 */
export const telemetry = {
  server: capsule({
    label: "telemetry",
    config: { ...sends, ...records },
    tags: [telemetrySide("server"), routes.ns({ op: telemetryRoute, ns: quiet })],
    exports: { route: telemetryRoute },
    hooks: queueSink,
  }),
  thread: capsule({
    label: "telemetry",
    config: { ...sends, ...records, worker: telemetryWorker.required },
    tags: [telemetrySide("server"), routes.ns({ op: threadRoute, ns: quiet })],
    exports: { route: threadRoute },
    hooks: threadSink,
  }),
  /** The worker thread's root: it sends what the ring brings, and traces nothing of its own. */
  worker: capsule({
    label: "telemetry",
    config: sends,
    tags: [telemetrySide("server")],
    hooks: queueSend,
  }),
};
