import { afterAll, expect, test } from "bun:test";

type Server = typeof import("../cmds/server");

/** The real server command, run in this process; the lint bans a static parent import. */
const server: Server = await import(new URL("../cmds/server.ts", import.meta.url).href);

/** Takes the telemetry the root sends, so nothing leaves this machine. */
const collector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
const stop = new AbortController();

const started = await server.default({
  env: {
    OTEL_SERVICE_NAME: "server-test",
    VICTORIA_TRACES_URL: `${collector.url}traces`,
    VICTORIA_LOGS_URL: `${collector.url}logs`,
    PUBLIC_ORIGIN: "https://app.example",
  },
  args: [],
  cwd: process.cwd(),
  signal: stop.signal,
  stdout: { write: () => true },
  stderr: { write: () => true },
  exit: (code, reason) => stop.abort(reason ?? code),
});

afterAll(async () => {
  stop.abort();
  await started.closed;
  await collector.stop();
});

/** A tab's call as it reaches the host behind a TLS proxy: an http request URL, an https Origin. */
const proxied = (path: string, body: unknown) =>
  started.fetch(
    new Request(`http://app.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify(body),
    }),
  );

test("PUBLIC_ORIGIN reaches rpc: a call from the public origin passes behind a TLS proxy", async () => {
  const reply = await proxied("/rpc/greet", { name: "Duke" });

  expect(reply?.status).toBe(200);
  expect(await reply?.json()).toEqual({ value: { text: "Hello, Duke." } });
});

test("PUBLIC_ORIGIN reaches telemetry: a tab batch from the public origin is taken", async () => {
  const reply = await proxied("/api/telemetry", { logs: [], traces: [] });

  expect(reply?.status).toBe(202);
});
