import { resource } from "@tinker/core";
import { httpBackend } from "../../backend/http-backend.ts";
import type { Telemetry } from "./records.ts";
import { telemetrySettings } from "./settings.ts";

/**
 * Sends one batch. The server and SSR sides post to storage; the browser posts to the base's
 * ingest route, so storage URLs never reach it. It sends through httpBackend with no request
 * span, or telemetry would trace itself (ADR 0102).
 */
export const delivery = resource({
  label: "telemetry.delivery",
  depends: { settings: telemetrySettings, backend: httpBackend },
  factory: ({ settings, backend }) => ({
    async send(batch: Telemetry.Batch, signal: AbortSignal): Promise<Telemetry.Delivery> {
      if (settings.side === "browser") {
        try {
          const response = await backend("/api/telemetry", {
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
      }
      const logs = new URL(settings.logs);
      logs.searchParams.set("_time_field", "time");
      logs.searchParams.set("_msg_field", "msg");
      logs.searchParams.set("_stream_fields", "service,side");
      const [tracesAccepted, logsAccepted] = await Promise.all([
        batch.traces.length === 0
          ? true
          : Promise.resolve().then(async () => {
              try {
                const response = await backend(settings.traces, {
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
                const response = await backend(logs.href, {
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
  }),
});
