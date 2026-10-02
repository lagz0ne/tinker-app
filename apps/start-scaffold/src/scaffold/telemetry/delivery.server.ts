import type { Telemetry } from "./records.ts";

/** The browser never receives storage URLs. Trace IDs remain fields, not log stream keys. */
export async function deliver(
  settings: Extract<Telemetry.Settings, { traces: string }>,
  batch: Telemetry.Batch,
  signal: AbortSignal,
): Promise<Telemetry.Delivery> {
  const post = async (url: string, body: string, contentType: string) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
        signal,
        redirect: "error",
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
  const logs = new URL(settings.logs);
  logs.searchParams.set("_time_field", "time");
  logs.searchParams.set("_msg_field", "msg");
  logs.searchParams.set("_stream_fields", "service,side");
  const [tracesAccepted, logsAccepted] = await Promise.all([
    batch.traces.length === 0
      ? true
      : post(
          settings.traces,
          JSON.stringify({
            resourceSpans: ["server", "browser", "ssr"].flatMap((side) => {
              const spans = batch.traces
                .filter((span) => span.side === side)
                .map(({ side: _side, ...span }) => span);
              return spans.length
                ? [
                    {
                      resource: {
                        attributes: [
                          { key: "service.name", value: { stringValue: settings.service } },
                          { key: "tinker.side", value: { stringValue: side } },
                        ],
                      },
                      scopeSpans: [{ scope: { name: "tinker.start" }, spans }],
                    },
                  ]
                : [];
            }),
          }),
          "application/json",
        ),
    batch.logs.length === 0
      ? true
      : post(
          logs.href,
          batch.logs.map((record) => JSON.stringify(record)).join("\n"),
          "application/stream+json",
        ),
  ]);
  return { traces: tracesAccepted, logs: logsAccepted };
}
