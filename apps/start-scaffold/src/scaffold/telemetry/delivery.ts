import { createIsomorphicFn } from "@tanstack/react-start";
import type { Telemetry } from "./records.ts";

export const deliver = createIsomorphicFn()
  .server(
    async (
      settings: Telemetry.Settings,
      batch: Telemetry.Batch,
      signal: AbortSignal,
    ): Promise<Telemetry.Delivery> => {
      if (settings.side === "browser") return { traces: true, logs: true };
      return (await import("./delivery.server.ts")).deliver(settings, batch, signal);
    },
  )
  .client(
    async (
      _settings: Telemetry.Settings,
      batch: Telemetry.Batch,
      signal: AbortSignal,
    ): Promise<Telemetry.Delivery> => {
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
  );
