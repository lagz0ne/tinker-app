import { createScope, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { httpBackend } from "~/components/http";
import { consoleOutput } from "~/components/telemetry/console";
import { threadDrain } from "~/components/telemetry/drain.server";
import { flushTelemetry, observer, telemetryExport } from "~/components/telemetry/observer";
import {
  logsUrl,
  telemetryService,
  telemetrySide,
  tracesUrl,
} from "~/components/telemetry/settings";
import { threadIngest, threadObserver, threadRing } from "~/components/telemetry/thread.server";

/** One storage fake and one console per path; each keeps every body it got. */
function sink() {
  const bodies: string[] = [];
  let text = "";
  return {
    bodies,
    lines: () => text,
    console: { write: (chunk: string) => void (text += chunk) },
    backend: (async (input, init) => {
      bodies.push(
        `${input instanceof Request ? input.url : input.toString()}\n${typeof init?.body === "string" ? init.body : ""}`,
      );
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };
}

/** A worker-side root, as cmds/telemetry-worker.ts binds it. */
function root(clock: ReturnType<typeof makeTestClock>, out: ReturnType<typeof sink>) {
  return createScope({
    clock,
    extensions: [telemetryExport],
    tags: [
      telemetryService("proof"),
      telemetrySide("server"),
      tracesUrl(new URL("http://storage.test/traces")),
      logsUrl(new URL("http://storage.test/logs")),
      httpBackend(out.backend),
      consoleOutput(out.console),
    ],
  });
}

const child = operation({
  label: "proof.child",
  run: (_deps, ctx) => {
    const cycle: Record<string, unknown> = {};
    cycle.loop = cycle;

    ctx.obs.event("saved", { count: 1, big: 42n, cycle, name: "ünïcode ✓" });
    ctx.obs.event("plain", { count: 2, nested: { a: [1, "b"] } });
    ctx.log("saved record", { count: 1, big: 42n, cycle, gone: undefined });
    ctx.log.warn("plain record", { count: 3, at: new Date(0), text: "x".repeat(3000) });
    return "saved";
  },
});

const parent = operation({
  label: "proof.parent",
  depends: { child },
  run: ({ child }) => child.run(),
});

const rejected = operation({
  label: "proof.rejected",
  run: (_deps, { raise }) => raise("Rollback", {}),
});

test("a span through the wire line reaches storage and console as the same records", async () => {
  const clock = makeTestClock({ now: 1_800_000_000_000 });
  const local = sink();
  const remote = sink();

  const inProcess = root(clock, local);
  const worker = root(clock, remote);
  const request = createScope({
    clock,
    tags: [telemetrySide("server"), telemetryService("proof")],
  });
  await Promise.all([inProcess.ready, worker.ready, request.ready]);

  const a = inProcess.resolve(observer);
  const b = request.resolve(threadObserver);
  const both: Observe.Config = {
    level: a.level,
    history: a.history,
    export: (span) => (a.export!(span), b.export!(span)),
    log: (entry) => (a.log!(entry), b.log!(entry)),
  };
  const app = createScope({ clock, observe: both });
  expect(app.run(parent)).toBe("saved");
  expect(app.settle(rejected).status).toBe("failed");
  request.resolve(threadIngest).ingest({
    traces: [],
    logs: [{ time: 1, level: 30, msg: "tab", service: "tab", side: "browser" }],
  });
  inProcess.resolve(observer);

  // Read the ring as the worker does: whole lines between the read and write indexes.
  const ring = request.resolve(threadRing);
  ring.push();
  const lines = new TextDecoder()
    .decode(ring.data.subarray(0, Atomics.load(ring.state, 0)))
    .split("\n")
    .slice(0, -1);

  const drain = worker.resolve(threadDrain);
  for (const line of lines) drain.take(line);
  await inProcess.run(flushTelemetry);
  await worker.run(flushTelemetry);

  expect(lines.length).toBeGreaterThan(4);
  expect(remote.bodies.length).toBeGreaterThan(0);
  // The tab line only went through the thread path.
  const tab = remote.bodies.find((body) => body.includes('"msg":"tab"'))!;
  const remoteBodies = remote.bodies.map((body) =>
    body
      .split("\n")
      .filter((line) => !line.includes('"msg":"tab"'))
      .join("\n"),
  );
  expect(tab).toContain('"service":"proof"');
  expect(remoteBodies).toEqual(local.bodies);
  expect(remote.lines()).toBe(local.lines());

  expect((await app.close({ graceful: true })).status).toBe("success");
  for (const owner of [request, inProcess, worker]) {
    expect((await owner.close({ graceful: true })).status).toBe("success");
  }
});

test("ring indexes past the signed 32-bit wrap still count unread bytes", async () => {
  const scope = createScope({});
  const ring = scope.resolve(threadRing);
  // 2 GiB of writes in: both indexes sit 100 bytes before the Int32 wrap.
  const near = 2 ** 31 - 100;
  ring.state[0] = near;
  ring.state[1] = near;

  const first = "ü".repeat(3 << 19);
  ring.write(first);
  ring.push();
  const at = Atomics.load(ring.state, 0);
  expect(at).toBeLessThan(0);
  expect(ring.dropped()).toBe(0);

  // Read the first turn as the worker does: from the read index, around the buffer's end.
  const mask = ring.data.length - 1;
  const bytes = new Uint8Array([
    ...ring.data.subarray(near & mask),
    ...ring.data.subarray(0, at & mask),
  ]);
  expect(new TextDecoder().decode(bytes)).toBe(`${first}\n`);

  // 3 MiB stay unread, so a 2 MiB turn does not fit and must not overwrite them.
  ring.write("y".repeat(2 << 20));
  ring.push();
  expect(ring.dropped()).toBe(1);
  expect(Atomics.load(ring.state, 0)).toBe(at);

  expect((await scope.close({ graceful: true })).status).toBe("success");
});
