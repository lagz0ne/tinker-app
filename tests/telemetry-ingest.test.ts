import { afterAll, beforeEach, expect, test } from "bun:test";

import { createScope } from "@tinker/core";

import { routes } from "~/components/requests/index.server";
import { telemetry } from "~/components/telemetry/index.server";

/** Keeps what the root sends, by path, so nothing leaves this machine. */
const sent: { traces: string[]; logs: string[] } = { traces: [], logs: [] };

const collector = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const path = new URL(request.url).pathname === "/traces" ? "traces" : "logs";
    sent[path].push(await request.text());
    return new Response(null, { status: 204 });
  },
});

const sends = {
  service: "ingest-test",
  tracesUrl: new URL(`${collector.url}traces`),
  logsUrl: new URL(`${collector.url}logs`),
};

/** The two server sinks: this thread's, and the worker's (the built server's). */
const sinks = {
  server: () => telemetry.server(sends),
  thread: () =>
    telemetry.thread({
      ...sends,
      worker: new URL("../cmds/telemetry-worker.ts", import.meta.url),
    }),
};

/** A tab log line, as the tab's sink sends it. */
const tabLine = { time: Date.now(), level: 30, msg: "tab line", service: "tab", side: "browser" };

beforeEach(() => {
  sent.traces.length = sent.logs.length = 0;
});

afterAll(async () => {
  await collector.stop();
});

for (const [name, make] of Object.entries(sinks)) {
  test(`${name}: a tab batch posted to /api/telemetry makes no server span or log line`, async () => {
    const sink = make();
    const stop = new AbortController();
    const app = createScope({
      capsules: [sink, routes({ stop: stop.signal, table: { "POST /api/telemetry": sink.route } })],
    });
    await app.ready;
    const post = () =>
      app.resolve(routes)(
        new Request("http://app.example/api/telemetry", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://app.example" },
          body: JSON.stringify({ traces: [], logs: [tabLine] }),
        }),
        app,
      );

    expect((await post())?.status).toBe(202);
    expect((await post())?.status).toBe(202);
    stop.abort();
    await app.close();

    // The server traced nothing for taking the batches; the tab's own lines still go out.
    const spans = sent.traces.flatMap((body) =>
      JSON.parse(body).resourceSpans.flatMap(
        (group: { scopeSpans: { spans: { name: string }[] }[] }) =>
          group.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
      ),
    );
    expect(spans).toEqual([]);
    const logs = sent.logs
      .join("\n")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(logs.filter((line) => line.side === "server")).toEqual([]);
    expect(logs.filter((line) => line.msg === "tab line")).toHaveLength(2);
  });
}
