import { resource } from "@tinker/core";

import { httpBackend } from "~/components/http";

import type { Telemetry } from "./records";
import { logsUrl, telemetryService, telemetrySide, tracesUrl } from "./settings";

/** Sends cached JSON without observing its own HTTP requests (ADR 0102). */
export const delivery = resource({
  label: "telemetry.delivery",
  depends: {
    side: telemetrySide,
    service: telemetryService,
    tracesUrl: tracesUrl.optional,
    logsUrl: logsUrl.optional,
    backend: httpBackend,
  },
  factory: ({ side, service, tracesUrl, logsUrl, backend }, ctx) => {
    let traces: URL | undefined;
    let logs: URL | undefined;
    if (side !== "browser") {
      if (!tracesUrl.present) return ctx.raise("MissingTag", { label: "telemetry.tracesUrl" });
      if (!logsUrl.present) return ctx.raise("MissingTag", { label: "telemetry.logsUrl" });

      traces = tracesUrl.value;
      logs = new URL(logsUrl.value);
      logs.searchParams.set("_time_field", "time");
      logs.searchParams.set("_msg_field", "msg");
      logs.searchParams.set("_stream_fields", "service,side");
    }

    return {
      async send(records: Telemetry.Record[], signal: AbortSignal): Promise<Telemetry.Delivery> {
        const browser = side === "browser";
        let batches: { url: string; body: string | undefined; contentType: string }[];
        if (browser) {
          const traces = records
            .filter((record) => record.kind === "trace")
            .map((record) => `{"side":"${record.side}",${record.json.slice(1)}`);
          const lines = records
            .filter((record) => record.kind === "log")
            .map((record) => record.json);
          batches = [
            {
              url: "/api/telemetry",
              body: `{"traces":[${traces.join(",")}],"logs":[${lines.join(",")}]}`,
              contentType: "application/json",
            },
          ];
        } else {
          const groups = ["server", "browser", "ssr"].flatMap((side) => {
            const spans = records
              .filter((record) => record.kind === "trace" && record.side === side)
              .map((record) => record.json);
            if (!spans.length) return [];

            const resource = JSON.stringify({
              attributes: [
                { key: "service.name", value: { stringValue: service } },
                { key: "tinker.side", value: { stringValue: side } },
              ],
            });
            return [
              `{"resource":${resource},"scopeSpans":[{"scope":{"name":"tinker.start"},"spans":[${spans.join(",")}]}]}`,
            ];
          });
          const lines = records
            .filter((record) => record.kind === "log")
            .map((record) => record.json);
          batches = [
            {
              url: traces!.href,
              body: groups.length ? `{"resourceSpans":[${groups.join(",")}]}` : undefined,
              contentType: "application/json",
            },
            {
              url: logs!.href,
              body: lines.length ? lines.join("\n") : undefined,
              contentType: "application/stream+json",
            },
          ];
        }

        const accepted = await Promise.all(
          batches.map(async ({ url, body, contentType }) => {
            if (body === undefined) return true;
            try {
              const response = await backend(url, {
                method: "POST",
                headers: { "content-type": contentType },
                body,
                signal,
                redirect: "error",
                ...(browser ? { credentials: "same-origin", keepalive: true } : {}),
              });
              await response.body?.cancel();
              return response.ok;
            } catch {
              return false;
            }
          }),
        );
        return { traces: accepted[0]!, logs: browser ? accepted[0]! : accepted[1]! };
      },
    };
  },
});
