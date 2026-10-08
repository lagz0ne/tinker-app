import { createScope, namespace, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { env } from "@tinker/start/server";
import {
  exportHealth,
  flushTelemetry,
  httpBackend,
  offTelemetry,
  serverTelemetry,
} from "@tinker/start/testing";

/** Main's server part has only `observe`; these defaults keep the regression runnable there. */
const telemetry = Object.assign(
  { renderObserve: serverTelemetry.observe, renderNs: namespace() },
  serverTelemetry,
);

const off = Object.assign(
  { renderObserve: offTelemetry.observe, renderNs: namespace() },
  offTelemetry,
);

const storageEnv = env({
  VICTORIA_TRACES_URL: "http://storage.test/traces",
  VICTORIA_LOGS_URL: "http://storage.test/logs",
  OTEL_SERVICE_NAME: "test-start",
});

const render = operation({ label: "test.render", run: () => "page" });

test("render close finishes while the process telemetry send is held", async () => {
  const gate = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const tools = createScope({
    clock: makeTestClock(),
    extensions: telemetry.extensions,
    tags: [
      storageEnv,
      telemetry.tags,
      httpBackend(async () => {
        sending.resolve();
        await gate.promise;
        return new Response(null, { status: 200 });
      }),
    ],
  });
  await tools.ready;
  const app = createScope({
    observe: tools.resolve(telemetry.renderObserve, { ns: telemetry.renderNs }),
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
    extensions: telemetry.extensions,
    tags: [
      storageEnv,
      telemetry.tags,
      httpBackend(async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return new Response(null, { status: 200 });
      }),
    ],
  });
  await tools.ready;
  for (let index = 0; index < 2; index++) {
    const app = createScope({
      observe: tools.resolve(telemetry.renderObserve, { ns: telemetry.renderNs }),
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

test("renders with telemetry off need no storage settings", async () => {
  const tools = createScope({ extensions: off.extensions, tags: off.tags });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(off.renderObserve, { ns: off.renderNs }) });
  expect(app.run(render)).toBe("page");
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});
