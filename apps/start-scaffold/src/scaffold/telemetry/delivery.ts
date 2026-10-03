import { resource } from "@tinker/core";
import { createIsomorphicFn } from "@tanstack/react-start";
import { telemetrySettings } from "./state.ts";
import type { Telemetry } from "./records.ts";

/** The server factory keeps storage URLs out of the browser. */
export const delivery = resource({
  label: "telemetry.delivery",
  depends: { settings: telemetrySettings.required },
  factory: createIsomorphicFn()
    .server(({ settings }) => ({
      async send(batch: Telemetry.Batch, signal: AbortSignal): Promise<Telemetry.Delivery> {
        if (settings.side === "browser") return { traces: true, logs: true };
        const logs = new URL(settings.logs);
        logs.searchParams.set("_time_field", "time");
        logs.searchParams.set("_msg_field", "msg");
        logs.searchParams.set("_stream_fields", "service,side");
        const [tracesAccepted, logsAccepted] = await Promise.all([
          batch.traces.length === 0
            ? true
            : Promise.resolve().then(async () => {
                try {
                  const response = await fetch(settings.traces, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    signal,
                    redirect: "error",
                    body: JSON.stringify({
                      resourceSpans: ["server", "browser", "ssr"].flatMap((side) => {
                        const spans = batch.traces
                          .filter((span) => span.side === side)
                          .map(({ side: _side, ...span }) => span);
                        return spans.length
                          ? [
                              {
                                resource: {
                                  attributes: [
                                    {
                                      key: "service.name",
                                      value: { stringValue: settings.service },
                                    },
                                    { key: "tinker.side", value: { stringValue: side } },
                                  ],
                                },
                                scopeSpans: [{ scope: { name: "tinker.start" }, spans }],
                              },
                            ]
                          : [];
                      }),
                    }),
                  });
                  await response.body?.cancel();
                  return response.ok;
                } catch {
                  return false;
                }
              }),
          batch.logs.length === 0
            ? true
            : Promise.resolve().then(async () => {
                try {
                  const response = await fetch(logs.href, {
                    method: "POST",
                    headers: { "content-type": "application/stream+json" },
                    signal,
                    redirect: "error",
                    body: batch.logs.map((record) => JSON.stringify(record)).join("\n"),
                  });
                  await response.body?.cancel();
                  return response.ok;
                } catch {
                  return false;
                }
              }),
        ]);
        return { traces: tracesAccepted, logs: logsAccepted };
      },
    }))
    .client(() => ({
      async send(batch: Telemetry.Batch, signal: AbortSignal): Promise<Telemetry.Delivery> {
        try {
          const response = await fetch("/api/telemetry", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(batch),
            signal,
            keepalive: true,
            redirect: "error",
          });
          await response.body?.cancel();
          return { traces: response.ok, logs: response.ok };
        } catch {
          return { traces: false, logs: false };
        }
      },
    })),
});
