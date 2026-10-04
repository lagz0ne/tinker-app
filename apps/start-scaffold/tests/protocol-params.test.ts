import { test, expect } from "vite-plus/test";
import { createScope } from "@tinker/core";
import {
  receiveTelemetry,
  browserTelemetry,
  backendStop,
  requestStop,
  telemetryOrigin,
} from "@tinker-start-scaffold/transport";
import { isError, raise } from "@tinker-start-scaffold/backend";

test("telemetry takes a plain batch and returns no HTTP reply", async () => {
  const accepted: unknown[] = [];
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      telemetryOrigin("http://localhost"),
      browserTelemetry(async (batch) => {
        accepted.push(batch);
      }),
    ],
  });
  await root.ready;
  try {
    const batch = { logs: [], traces: [] };
    const result = await root.settle(receiveTelemetry, { rawInput: batch });
    expect(result).toEqual({ status: "success", value: undefined });
    expect(accepted).toEqual([batch]);
  } finally {
    await root.close({ graceful: true });
  }
});

test("telemetry raises a managed error after backend stop", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      telemetryOrigin("http://localhost"),
      browserTelemetry(async () => {
        raise("BadInput", { reason: "must not ingest" });
      }),
    ],
  });
  await root.ready;
  stop.abort();
  try {
    const result = await root.settle(receiveTelemetry, { rawInput: { logs: [], traces: [] } });
    if (result.status !== "failed" || !isError(result.error, "Cancelled")) throw result;
    expect(result.error.payload).toEqual({});
  } finally {
    await root.close({ graceful: true });
  }
});
