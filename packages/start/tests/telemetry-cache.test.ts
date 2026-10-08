import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { httpBackend } from "../src/backend/http-backend";
import { env } from "../src/env";
import { exportHealth } from "../src/parts/telemetry/health";
import { flushTelemetry, ingestTelemetry, telemetryExport } from "../src/parts/telemetry/observer";
import type { Telemetry } from "../src/parts/telemetry/records";
import { telemetrySide } from "../src/parts/telemetry/settings";

const log: Telemetry.Log = {
  time: 1,
  level: 30,
  service: "s",
  side: "ssr",
  msg: "😀漢é",
  attributes: { k: "v" },
};

const span: Telemetry.Span = {
  side: "ssr",
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  flags: 1,
  name: "😀漢é",
  kind: 1,
  startTimeUnixNano: "0",
  endTimeUnixNano: "12000000",
  attributes: [],
  events: [],
  status: { code: 1 },
};

test("cached records keep exact log bytes and trace fields through a retry", async () => {
  const bodies: string[] = [];
  let refused = true;
  const root = createScope({
    extensions: [telemetryExport],
    tags: [
      env({ OTEL_SERVICE_NAME: "s" }),
      telemetrySide("ssr"),
      httpBackend(async (_input, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return new Response(null, { status: refused ? 503 : 200 });
      }),
    ],
  });
  await root.ready;
  root.run(ingestTelemetry, { input: { traces: [span], logs: [log] } });
  await root.run(flushTelemetry);
  refused = false;
  await root.run(flushTelemetry);
  const { side: _side, ...wire } = span;
  expect(bodies).toEqual([
    JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "s" } },
              { key: "tinker.side", value: { stringValue: "ssr" } },
            ],
          },
          scopeSpans: [{ scope: { name: "tinker.start" }, spans: [wire] }],
        },
      ],
    }),
    JSON.stringify(log),
    bodies[0],
    JSON.stringify(log),
  ]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a full queue drops a record without reading its message", async () => {
  const root = createScope({
    extensions: [telemetryExport],
    tags: [env({}), telemetrySide("ssr"), httpBackend(async () => new Response(null))],
  });
  await root.ready;
  for (let index = 0; index < 8; index++)
    root.run(ingestTelemetry, {
      input: { traces: [], logs: Array.from({ length: 64 }, () => log) },
    });
  const unread = { ...log };
  Object.defineProperty(unread, "msg", {
    get: () => expect.unreachable("a full queue must not encode the record"),
  });
  root.run(ingestTelemetry, { input: { traces: [], logs: [unread] } });
  expect(root.resolve(exportHealth)).toMatchObject({ pending: 512, dropped: 1 });
  expect((await root.close({ graceful: true })).status).toBe("success");
});
