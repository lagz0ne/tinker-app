import { serve } from "@tinker/bun";
import { createScope } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { afterAll, expect, test } from "vite-plus/test";

import { telemetry } from "~/components/telemetry/index.server";

type Server = typeof import("../cmds/server");

/** The real server command, run in this process; the lint bans a static parent import. */
const server: Server = await import(new URL("../cmds/server.ts", import.meta.url).href);

/** Takes the telemetry the root sends, so nothing leaves this machine. */
const collector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
const stop = new AbortController();

/** The command's root: a test reads where its `serve` listens. */
type Root = Scope.Starting & { readonly closed: Promise<unknown> };

const started = (await server.default({
  env: {
    PORT: "0",
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
})) as Root;

/** Where a root's `serve` listens. */
const urlOf = (root: Root) => root.resolve(serve.url).get()!;

afterAll(async () => {
  stop.abort();
  await started.closed;
  await collector.stop();
});

/** A tab's call as it reaches the host behind a TLS proxy: an http request URL, an https Origin. */
const proxied = (path: string, body: unknown) =>
  fetch(new URL(path, urlOf(started)), {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example" },
    body: JSON.stringify(body),
  });

/** One greet over the command's own port, on a socket that sends `origin`. */
async function greetOver(root: Root, origin: string) {
  // Bun's WebSocket takes headers: a browser sets Origin itself.
  const socket = new WebSocket(`ws://${urlOf(root).host}/rpc`, { headers: { origin } } as never);
  const reply = await new Promise<string>((done) => {
    socket.onopen = () => socket.send(JSON.stringify([{ i: 1, a: "greet", t: '{"name":"Duke"}' }]));
    socket.onmessage = (e) => done(JSON.parse(String(e.data))[0].t);
    socket.onclose = (e) => done(`closed ${e.code}`);
    socket.onerror = () => done("refused");
  });

  socket.close();
  return reply;
}

test("PUBLIC_ORIGIN reaches rpc: a socket from the public origin passes behind a TLS proxy", async () => {
  expect(JSON.parse(await greetOver(started, "https://app.example"))).toEqual({
    ok: true,
    value: { text: "Hello, Duke." },
  });
  expect(await greetOver(started, "https://evil.example")).not.toContain("Hello");
});

test("PUBLIC_ORIGIN reaches telemetry: a tab batch from the public origin is taken", async () => {
  const reply = await proxied("/api/telemetry", { logs: [], traces: [] });

  expect(reply?.status).toBe(202);
});

test("an empty PUBLIC_ORIGIN counts as unset: rpc and telemetry take the request URL's origin", async () => {
  const quiet = new AbortController();
  const plain = (await server.default({
    env: {
      PORT: "0",
      OTEL_SERVICE_NAME: "server-test",
      VICTORIA_TRACES_URL: `${collector.url}traces`,
      VICTORIA_LOGS_URL: `${collector.url}logs`,
      PUBLIC_ORIGIN: "",
    },
    args: [],
    cwd: process.cwd(),
    signal: quiet.signal,
    stdout: { write: () => true },
    stderr: { write: () => true },
    exit: (code, reason) => quiet.abort(reason ?? code),
  })) as Root;
  const at = urlOf(plain);
  const post = (path: string, body: unknown) =>
    fetch(new URL(path, at), {
      method: "POST",
      headers: { "content-type": "application/json", origin: at.origin },
      body: JSON.stringify(body),
    });

  // The socket's request URL is http://localhost:<port>, so that is the origin it takes.
  const local = await greetOver(plain, "http://localhost");
  expect(local).toBe("refused"); // port differs: not the request URL's origin
  expect((await post("/api/telemetry", { logs: [], traces: [] }))?.status).toBe(202);
  quiet.abort();
  await plain.closed;
});

test("a telemetry origin that is not an http(s) URL fails its root's start, naming telemetry.origin", async () => {
  const failureOf = async (origin: string) => {
    const sink = telemetry.server({
      service: "server-test",
      tracesUrl: new URL(`${collector.url}traces`),
      logsUrl: new URL(`${collector.url}logs`),
      origin,
    });
    try {
      await createScope({ capsules: [sink] }).close();
      return { origin, kind: undefined, label: undefined };
    } catch (error) {
      const { kind, payload } = Object(error);
      return { origin, kind, label: Object(payload).label };
    }
  };

  // No scheme, a file URL (its origin is "null"), another scheme, and "null" itself.
  const origins = ["app.example", "file:///x", "ftp://app.example", "null"];
  expect(await Promise.all(origins.map(failureOf))).toEqual(
    origins.map((origin) => ({ origin, kind: "DataValidationFailed", label: "telemetry.origin" })),
  );
});
