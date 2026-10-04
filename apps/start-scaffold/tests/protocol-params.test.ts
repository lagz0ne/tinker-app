import { test, expect } from "vite-plus/test";
import { createScope } from "@tinker/core";
import {
  receiveTelemetry,
  browserTelemetry,
  backendStop,
  requestStop,
  telemetryOrigin,
  openSync,
} from "@tinker-start-scaffold/transport";
import {
  isError,
  raise,
  databaseSettings,
  mailSettings,
  authSettings,
  migrate,
} from "@tinker-start-scaffold/backend";
import { proofDatabase, proofMail, requestHeaders } from "@tinker-start-scaffold/testing";

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

test("sync takes a cursor param and returns the body stream", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [
      databaseSettings({ url: "postgres://proof", migrations: "drizzle" }),
      mailSettings({
        host: "proof",
        port: 25,
        user: "proof",
        password: "proof",
        from: "proof@example.com",
      }),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
        plugins: [],
      }),
      backendStop(stop.signal),
      requestStop(stop.signal),
      requestHeaders(new Headers()),
    ],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const result = await root.settle(openSync, {
      rawInput: { cursor: { public: 4, private: null } },
    });
    if (result.status !== "success") throw result;
    const reader = result.value.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    await reader.cancel();
  } finally {
    stop.abort();
    await root.close({ graceful: true });
  }
});
