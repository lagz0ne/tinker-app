import { existsSync, closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { consoleOutput } from "~/components/telemetry/console";
import type { ConsoleOutput } from "~/components/telemetry/console";
import { exportHealth } from "~/components/telemetry/health";
import {
  logsUrl,
  telemetryService,
  telemetrySide,
  tracesUrl,
} from "~/components/telemetry/settings";
import {
  telemetryThread,
  telemetryWorker,
  threadExport,
  threadObserver,
} from "~/components/telemetry/thread.server";

/** The worker as `vp build` emits it; CI builds every app before its tests. */
const built = new URL("../../dist/server/telemetry-worker.js", import.meta.url);

/** A storage on a free port: it keeps each body, or never answers when `stuck`. */
async function storage(stuck = false) {
  const bodies: { url: string; body: string }[] = [];
  const server = createServer((request, response) => {
    // A body can arrive in several reads, cut inside a character: decode it once, whole.
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString() });
      if (!stuck) response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;
  return {
    bodies,
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The server command's request-side telemetry root; a number puts the console mirror on that file. */
function requestRoot(module: URL, origin: string, output: number | ConsoleOutput.Sink) {
  const tools = createScope({
    extensions: [threadExport],
    tags: [
      telemetryWorker(module),
      telemetrySide("server"),
      telemetryService("proof"),
      tracesUrl(new URL(`${origin}/traces`)),
      logsUrl(new URL(`${origin}/logs`)),
      consoleOutput(typeof output === "number" ? { fd: output, write: () => undefined } : output),
    ],
  });
  const health = { last: tools.resolve(exportHealth) };
  tools.controller(exportHealth).watch((next) => (health.last = next));
  return { tools, health };
}

const saved = operation({
  label: "proof.saved",
  run: (_deps, ctx) => {
    ctx.obs.event("saved", { count: 1, big: 42n });
    ctx.log("saved record", { count: 1 });
    return "saved";
  },
});

test("the built worker sends every span and log line, mirrors the console, and closes clean", async () => {
  expect(existsSync(built), "run `vp build` before this test").toBe(true);
  const sink = await storage();
  const file = join(tmpdir(), `telemetry-worker-${process.pid}.log`);
  const fd = openSync(file, "w");

  try {
    const { tools, health } = requestRoot(built, sink.origin, fd);
    await tools.ready;

    const app = createScope({ observe: tools.resolve(threadObserver) });
    for (let index = 0; index < 100; index++) expect(app.run(saved)).toBe("saved");
    await (await tools.resolve(telemetryThread)).flush();

    const traces = sink.bodies.filter((body) => body.url === "/traces");
    const logs = sink.bodies.filter((body) => body.url.startsWith("/logs"));
    const spans = traces.flatMap(
      (body) =>
        (JSON.parse(body.body) as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] })
          .resourceSpans[0]!.scopeSpans[0]!.spans,
    );
    const lines = logs.flatMap((body) => body.body.split("\n")).filter(Boolean);
    expect(spans).toHaveLength(100);
    expect(lines).toHaveLength(200);
    expect(traces[0]!.body).toContain('"stringValue":"42"');

    expect((await app.close({ graceful: true })).status).toBe("success");
    expect((await tools.close({ graceful: true })).status).toBe("success");
    expect(health.last).toEqual({ kind: "idle", pending: 0, dropped: 0 });

    const mirror = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(mirror).toHaveLength(200);
    expect(mirror.filter((line) => line.includes('"msg":"core.span"'))).toHaveLength(100);
  } finally {
    closeSync(fd);
    rmSync(file, { force: true });
    sink.close();
  }
});

const wide = operation({
  label: "proof.wide",
  run: (_deps, ctx) => ctx.obs.event("wide", { text: "ü✓".repeat(200) }),
});

/** Every span body's `text` event value, from the storage's trace posts. */
function wideValues(bodies: { url: string; body: string }[]) {
  return bodies
    .filter((body) => body.url === "/traces")
    .flatMap((body) => body.body.match(/"stringValue":"\\"(ü✓)+\\""/g) ?? []);
}

test("lines that wrap the 4 MiB ring arrive whole, multi-byte characters too", async () => {
  expect(existsSync(built), "run `vp build` before this test").toBe(true);
  const sink = await storage();
  const fd = openSync(join(tmpdir(), `telemetry-wrap-${process.pid}.log`), "w");

  try {
    const { tools, health } = requestRoot(built, sink.origin, fd);
    await tools.ready;

    const app = createScope({ observe: tools.resolve(threadObserver) });
    const thread = await tools.resolve(telemetryThread);
    for (let turn = 0; turn < 40; turn++) {
      for (let index = 0; index < 100; index++) app.run(wide);
      await thread.flush();
    }

    expect((await app.close({ graceful: true })).status).toBe("success");
    expect((await tools.close({ graceful: true })).status).toBe("success");
    expect(wideValues(sink.bodies)).toEqual(
      Array.from({ length: 4000 }, () => `"stringValue":"\\"${"ü✓".repeat(200)}\\""`),
    );
    expect(health.last).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  } finally {
    closeSync(fd);
    rmSync(join(tmpdir(), `telemetry-wrap-${process.pid}.log`), { force: true });
    sink.close();
  }
});

test("a turn larger than the ring is dropped and counted, and later turns still arrive", async () => {
  expect(existsSync(built), "run `vp build` before this test").toBe(true);
  const sink = await storage();
  const fd = openSync(join(tmpdir(), `telemetry-full-${process.pid}.log`), "w");

  try {
    const { tools, health } = requestRoot(built, sink.origin, fd);
    await tools.ready;

    const app = createScope({ observe: tools.resolve(threadObserver) });
    for (let index = 0; index < 3500; index++) app.run(wide);
    await (await tools.resolve(telemetryThread)).flush();
    // The worker saw nothing, so only the request side can report this drop.
    expect(health.last).toEqual({ kind: "idle", pending: 0, dropped: 3500 });
    app.run(wide);

    expect((await app.close({ graceful: true })).status).toBe("success");
    expect((await tools.close({ graceful: true })).status).toBe("success");
    expect(wideValues(sink.bodies)).toHaveLength(1);
    expect(health.last).toEqual({ kind: "idle", pending: 0, dropped: 3500 });
  } finally {
    closeSync(fd);
    rmSync(join(tmpdir(), `telemetry-full-${process.pid}.log`), { force: true });
    sink.close();
  }
});

test("a host sink with no descriptor still gets every console line", async () => {
  expect(existsSync(built), "run `vp build` before this test").toBe(true);
  const sink = await storage();
  let text = "";

  try {
    const { tools, health } = requestRoot(built, sink.origin, {
      write: (chunk: string) => void (text += chunk),
    });
    await tools.ready;

    const app = createScope({ observe: tools.resolve(threadObserver) });
    for (let index = 0; index < 100; index++) expect(app.run(saved)).toBe("saved");
    await (await tools.resolve(telemetryThread)).flush();

    expect((await app.close({ graceful: true })).status).toBe("success");
    expect((await tools.close({ graceful: true })).status).toBe("success");
    expect(health.last).toEqual({ kind: "idle", pending: 0, dropped: 0 });

    const mirror = text.split("\n").filter(Boolean);
    expect(mirror).toHaveLength(200);
    expect(mirror.filter((line) => line.includes('"msg":"core.span"'))).toHaveLength(100);
  } finally {
    sink.close();
  }
});

test("a storage that never answers still lets the worker close within its bound", async () => {
  expect(existsSync(built), "run `vp build` before this test").toBe(true);
  const sink = await storage(true);
  const fd = openSync(join(tmpdir(), `telemetry-stuck-${process.pid}.log`), "w");

  try {
    const { tools, health } = requestRoot(built, sink.origin, fd);
    await tools.ready;

    const app = createScope({ observe: tools.resolve(threadObserver) });
    for (let index = 0; index < 100; index++) app.run(saved);
    expect((await app.close({ graceful: true })).status).toBe("success");

    const started = performance.now();
    expect((await tools.close({ graceful: true })).status).toBe("success");
    expect(performance.now() - started).toBeLessThan(3500);
    expect(sink.bodies.length).toBeGreaterThan(0);
    expect(health.last.dropped).toBeGreaterThan(0);
  } finally {
    closeSync(fd);
    rmSync(join(tmpdir(), `telemetry-stuck-${process.pid}.log`), { force: true });
    sink.close();
  }
});

test("a worker that cannot load fails the telemetry root's start", async () => {
  const sink = await storage();
  const fd = openSync(join(tmpdir(), `telemetry-missing-${process.pid}.log`), "w");

  try {
    const { tools, health } = requestRoot(new URL("./missing-worker.js", built), sink.origin, fd);
    await expect(tools.ready).rejects.toThrow(/Cannot find module/);
    expect(health.last.kind).toBe("failed");
    await tools.close();
  } finally {
    closeSync(fd);
    rmSync(join(tmpdir(), `telemetry-missing-${process.pid}.log`), { force: true });
    sink.close();
  }
});
