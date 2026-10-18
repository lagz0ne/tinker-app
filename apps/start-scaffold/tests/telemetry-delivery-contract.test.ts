import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { httpBackend } from "~/components/http";
import { delivery } from "~/components/telemetry/delivery";
import type { Telemetry } from "~/components/telemetry/records";
import {
  logsUrl,
  telemetryService,
  telemetrySide,
  tracesUrl,
} from "~/components/telemetry/settings";

for (const missing of ["traces", "logs"] as const) {
  test(`worker export rejects a missing ${missing} URL with its tag name`, async () => {
    const root = createScope({
      tags: [
        telemetryService("proof"),
        telemetrySide("worker"),
        ...(missing === "traces"
          ? [logsUrl(new URL("http://logs.test/"))]
          : [tracesUrl(new URL("http://traces.test/"))]),
      ],
    });
    try {
      expect(() => root.resolve(delivery)).toThrow(
        expect.objectContaining({
          kind: "MissingTag",
          payload: { label: `telemetry.${missing}Url` },
        }),
      );
    } finally {
      await root.close();
    }
  });
}

for (const side of ["worker", "browser"] as const) {
  test(`${side} exports exact trace groups, log lines, and closes every response body`, async () => {
    const requests: { url: unknown; init: RequestInit | undefined }[] = [];
    let cancelled = 0;
    let status = 200;
    const signal = new AbortController().signal;
    const root = createScope({
      tags: [
        telemetryService("proof"),
        telemetrySide(side),
        tracesUrl(new URL("http://storage.test/traces")),
        logsUrl(new URL("http://storage.test/logs?custom=kept")),
        httpBackend(async (url, init) => {
          requests.push({ url, init });
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status },
          );
        }),
      ],
    });
    const records: Telemetry.Record[] = [
      { kind: "trace", side: "worker", json: '{"name":"mail.worker"}', bytes: 22 },
      { kind: "trace", side: "browser", json: '{"name":"click"}', bytes: 16 },
      { kind: "log", side: "worker", json: '{"msg":"one"}', bytes: 13 },
      { kind: "log", side: "worker", json: '{"msg":"two"}', bytes: 13 },
    ];

    try {
      const sender = root.resolve(delivery);

      expect(await sender.send(records, signal)).toEqual({ traces: true, logs: true });
      expect(requests).toHaveLength(side === "browser" ? 1 : 2);
      expect(cancelled).toBe(requests.length);
      for (const { init } of requests) {
        expect(init).toMatchObject({ method: "POST", signal, redirect: "error" });
        if (side === "browser") {
          expect(init).toMatchObject({ credentials: "same-origin", keepalive: true });
        } else {
          expect(init).not.toHaveProperty("credentials");
          expect(init).not.toHaveProperty("keepalive");
        }
      }
      if (side === "browser") {
        expect(requests[0]!.url).toBe("/api/telemetry");
        expect(requests[0]!.init!.headers).toEqual({ "content-type": "application/json" });
        expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({
          traces: [
            { side: "worker", name: "mail.worker" },
            { side: "browser", name: "click" },
          ],
          logs: [{ msg: "one" }, { msg: "two" }],
        });
      } else {
        expect(requests[0]!.url).toBe("http://storage.test/traces");
        const body = JSON.parse(requests[0]!.init!.body as string);

        expect(body.resourceSpans).toHaveLength(2);
        expect(body.resourceSpans).toEqual(
          ["browser", "worker"].map((from) => ({
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "proof" } },
                { key: "tinker.side", value: { stringValue: from } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "tinker.start" },
                spans: [{ name: from === "worker" ? "mail.worker" : "click" }],
              },
            ],
          })),
        );
        expect(new URL(String(requests[1]!.url)).searchParams.get("custom")).toBe("kept");
        expect(requests[1]!.init!.headers).toEqual({ "content-type": "application/stream+json" });
        expect(requests[1]!.init!.body).toBe('{"msg":"one"}\n{"msg":"two"}');
      }
      requests.length = 0;
      if (side === "worker") {
        expect(await sender.send([], signal)).toEqual({ traces: true, logs: true });
        expect(requests).toEqual([]);
      }
      status = 503;
      expect(await sender.send(records, signal)).toEqual({ traces: false, logs: false });
      expect(cancelled).toBe(side === "browser" ? 2 : 4);
    } finally {
      await root.close();
    }
  });
}
