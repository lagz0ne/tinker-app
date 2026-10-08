import { resource } from "@tinker/core";
import { httpBackend } from "../../backend/http-backend";
import type { Telemetry } from "./records";
import { telemetrySettings } from "./settings";

function browserBody(records: Telemetry.Record[]) {
  const traces: string[] = [];
  const logs: string[] = [];
  for (const record of records) {
    if (record.kind === "trace") traces.push(`{"side":"${record.side}",${record.json.slice(1)}`);
    else logs.push(record.json);
  }
  return `{"traces":[${traces.join(",")}],"logs":[${logs.join(",")}]}`;
}

function tracesBody(records: Telemetry.Record[], service: string) {
  const groups: string[] = [];
  for (const side of ["server", "browser", "ssr"]) {
    const spans: string[] = [];
    for (const record of records)
      if (record.kind === "trace" && record.side === side) spans.push(record.json);
    if (!spans.length) continue;
    const resource = JSON.stringify({
      attributes: [
        { key: "service.name", value: { stringValue: service } },
        { key: "tinker.side", value: { stringValue: side } },
      ],
    });
    groups.push(
      `{"resource":${resource},"scopeSpans":[{"scope":{"name":"tinker.start"},"spans":[${spans.join(",")}]}]}`,
    );
  }
  return groups.length ? `{"resourceSpans":[${groups.join(",")}]}` : undefined;
}

/** Sends cached JSON without observing its own HTTP requests (ADR 0102). */
export const delivery = resource({
  label: "telemetry.delivery",
  depends: { settings: telemetrySettings, backend: httpBackend },
  factory: ({ settings, backend }) => {
    const logs = settings.side === "browser" ? undefined : new URL(settings.logs);
    logs?.searchParams.set("_time_field", "time");
    logs?.searchParams.set("_msg_field", "msg");
    logs?.searchParams.set("_stream_fields", "service,side");
    const post = async (
      url: string,
      body: string | undefined,
      signal: AbortSignal,
      contentType: string,
      browser = false,
    ) => {
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
    };
    return {
      async send(records: Telemetry.Record[], signal: AbortSignal): Promise<Telemetry.Delivery> {
        if (settings.side === "browser") {
          const accepted = await post(
            "/api/telemetry",
            browserBody(records),
            signal,
            "application/json",
            true,
          );
          return { traces: accepted, logs: accepted };
        }
        const lines: string[] = [];
        for (const record of records) if (record.kind === "log") lines.push(record.json);
        const [traces, acceptedLogs] = await Promise.all([
          post(settings.traces, tracesBody(records, settings.service), signal, "application/json"),
          post(
            logs!.href,
            lines.length ? lines.join("\n") : undefined,
            signal,
            "application/stream+json",
          ),
        ]);
        return { traces, logs: acceptedLogs };
      },
    };
  },
});
