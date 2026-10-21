import { createScope } from "@tinker/core";

import { checkClosed } from "~/base/main";
import { serveTelemetryWorker, telemetryWorkerInput } from "~/base/telemetry-worker";
import {
  consoleOutput,
  logsUrl,
  telemetryExport,
  telemetryService,
  telemetrySide,
  threadDrain,
  tracesUrl,
} from "~/components/telemetry/index.server";

/**
 * The telemetry worker thread's root. The server's telemetry root starts it and owns its close.
 * The request side resolved every setting; this command binds them inline.
 */
const { settings, console } = telemetryWorkerInput();

const tools = createScope({
  extensions: [telemetryExport],
  tags: [
    telemetrySide("server"),
    telemetryService(settings.service),
    tracesUrl(new URL(settings.traces)),
    logsUrl(new URL(settings.logs)),
    consoleOutput(console),
  ],
});

await tools.ready;

await serveTelemetryWorker(tools.resolve(threadDrain));

checkClosed(await tools.close({ graceful: true }));
