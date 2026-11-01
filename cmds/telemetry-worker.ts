import { createScope } from "@tinker/core";

import { serveTelemetryWorker, telemetryWorkerInput } from "~/base/telemetry-worker";
import { telemetry, threadDrain } from "~/components/telemetry/index.server";

/**
 * The telemetry worker thread's root. The server's telemetry root starts it and owns its close.
 * The request side resolved every setting; this command binds them inline.
 */
const { settings, console } = telemetryWorkerInput();

const root = createScope({
  capsules: [
    telemetry.worker({
      service: settings.service,
      tracesUrl: new URL(settings.traces),
      logsUrl: new URL(settings.logs),
      console,
    }),
  ],
});

await root.ready;

await serveTelemetryWorker(root.resolve(threadDrain));

const ended = await root.close({ graceful: true });

// A throw ends this thread with an error event; the server's telemetryThread then stops failed.
if (ended.status === "failed") throw ended.error;
if (ended.teardownErrors?.length) throw ended.teardownErrors[0];
