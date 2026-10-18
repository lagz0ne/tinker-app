import { createScope, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { httpBackend } from "~/components/http";
import { exportHealth } from "~/components/telemetry/health";
import {
  renderObserve,
  renderNs,
  telemetryExport,
  telemetrySide,
} from "~/components/telemetry/index.server";
import { flushTelemetry } from "~/components/telemetry/observer";
import { logsUrl, telemetryService, tracesUrl } from "~/components/telemetry/settings";

const storageTags = [
  telemetryService("test-start"),
  tracesUrl(new URL("http://storage.test/traces")),
  logsUrl(new URL("http://storage.test/logs")),
];

const render = operation({ label: "test.render", run: () => "page" });

test("render close finishes while the process telemetry send is held", async () => {
  const gate = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const tools = createScope({
    clock: makeTestClock(),
    extensions: [telemetryExport],
    tags: [
      storageTags,
      telemetrySide("server"),
      httpBackend(async () => {
        sending.resolve();
        await gate.promise;
        return new Response(null, { status: 200 });
      }),
    ],
  });
  await tools.ready;

  const app = createScope({
    observe: tools.resolve(renderObserve, { ns: renderNs }),
  });
  expect(app.run(render)).toBe("page");

  const send = tools.run(flushTelemetry);
  await sending.promise;
  try {
    expect((await app.close({ graceful: true })).status).toBe("success");
    expect(tools.resolve(exportHealth)).toMatchObject({ kind: "sending", pending: 2 });
  } finally {
    gate.resolve();
    await send;
    expect((await tools.close({ graceful: true })).status).toBe("success");
  }
});

test("process close sends two renders from one queue with side ssr", async () => {
  const requests: string[] = [];
  const tools = createScope({
    clock: makeTestClock(),
    extensions: [telemetryExport],
    tags: [
      storageTags,
      telemetrySide("server"),
      httpBackend(async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return new Response(null, { status: 200 });
      }),
    ],
  });
  await tools.ready;

  for (let index = 0; index < 2; index++) {
    const app = createScope({
      observe: tools.resolve(renderObserve, { ns: renderNs }),
    });
    expect(app.run(render)).toBe("page");
    expect((await app.close({ graceful: true })).status).toBe("success");
  }

  expect(tools.resolve(exportHealth)).toMatchObject({ pending: 4 });
  expect(requests).toEqual([]);

  expect((await tools.close({ graceful: true })).status).toBe("success");
  expect(requests).toEqual([
    expect.stringContaining('"stringValue":"ssr"'),
    expect.stringContaining('"side":"ssr"'),
  ]);
  expect(JSON.parse(requests.at(0) ?? "{}").resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
});

test("renders without copied telemetry need no tools root or storage settings", async () => {
  const app = createScope();
  await app.ready;
  expect(app.run(render)).toBe("page");
  expect(app.spans()).toEqual([]);
  expect((await app.close({ graceful: true })).status).toBe("success");
});
