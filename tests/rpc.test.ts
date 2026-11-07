import { afterAll, expect, test } from "bun:test";

import { createScope, isError, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { hook } from "~/components/protocol";
import { rpc } from "~/components/rpc";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

// The template app's api over the socket, and the rules of ws.server: origin, frame size.

const more = rpc({
  refuse: { input: z.object({ why: z.string() }), output: z.null() },
  crash: { input: z.null(), output: z.null() },
});

/** An `onStart` that says no: the call answers `refused`, with this payload. */
const no = operation({
  label: "no",
  input: hook.start,
  run: async (_deps, { input }) => input.refuse({ message: "no" }),
});

const crashHere = operation({
  label: "crash.here",
  input: z.null(),
  run: async (): Promise<null> => {
    throw new Error("db password is hunter2");
  },
});

const refuseHere = operation({
  label: "refuse.here",
  input: more.refuse.input,
  run: async () => null,
});

const spans: string[] = [];
const lines: string[] = [];

const observe: Observe.Config = {
  export: (span) => void spans.push(span.name),
  log: (line) => void lines.push(`${line.message} ${JSON.stringify(line.attributes)}`),
};

const backend = createScope({
  observe,
  capsules: [
    api({ implement: { greet: greetHere } }),
    more({ implement: { refuse: { run: refuseHere, onStart: [no] }, crash: crashHere } }),
    server.server({ path: "/rpc", services: [api, more] }),
  ],
});

await backend.ready;
const http = listen(backend, [server.server]);
const base = `${http.url}/rpc`;

const browser = createScope({
  capsules: [tab.client({ url: base }), api({ remote: tab.client }), more({ remote: tab.client })],
});

await browser.ready;

afterAll(async () => {
  await browser.close();
  await http.bun.stop(true);
  await backend.close();
});

/** A server root with one more bound option, for the socket rules. */
const serverWith = (options: { origin?: string; maxPayload?: number }) =>
  createScope({
    capsules: [
      api({ implement: { greet: greetHere } }),
      server.server({ path: "/rpc", services: [api], ...options }),
    ],
  });

/** One raw frame on a fresh socket: the first answer back, or the close code. */
const raw = async (frame: string, url = base) => {
  const socket = new WebSocket(url);
  const got = await new Promise<{ t?: string; e?: number; closed?: number }>((done) => {
    socket.onopen = () => socket.send(frame);
    socket.onmessage = (e) => done(JSON.parse(String(e.data))[0]);
    socket.onclose = (e) => done({ closed: e.code });
  });

  socket.close();
  return got;
};

const greetFrame = (name: string, extra = {}) =>
  JSON.stringify([{ i: 1, a: "greet", t: JSON.stringify({ name }), ...extra }]);

test("the client runs api.greet; the server's implementation does the work", async () => {
  spans.length = 0;
  const reply = await browser.run(api.greet, { input: { name: "Duke" } });

  expect(reply).toEqual({ text: "Hello, Duke." });
  expect(spans).toContain("greet.here");
});

test("the server runs the same handle here, on its implementation", async () => {
  expect(await backend.run(api.greet, { input: { name: "here" } })).toEqual({
    text: "Hello, here.",
  });
});

test("bad input fails with DataValidationFailed on the client; nothing is sent", async () => {
  spans.length = 0;
  const result = await browser.settle(api.greet, { rawInput: { name: "" } });

  expect(result.status).toBe("failed");
  expect(isError(Object(result).error, "DataValidationFailed")).toBe(true);
  expect(spans).not.toContain("greet.here");
});

test("a refusal crosses as the refused fault, with its payload", async () => {
  const error = await browser.run(more.refuse, { input: { why: "no" } }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(more.fault.is(error) && [error.fault, error.payload]).toEqual([
    "refused",
    { message: "no" },
  ]);
});

test("a throw on the server is the failed fault; its cause stays in the server log", async () => {
  const error = await browser.run(more.crash, { input: null }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(more.fault.is(error) && [error.fault, error.payload]).toEqual(["failed", {}]);
  expect(JSON.stringify(error)).not.toContain("hunter2");
  expect(lines.some((line) => line.startsWith("rpc call failed") && line.includes("hunter2"))).toBe(
    true,
  );
});

test("with no rpc capsule, a run of a key fails loud: CapsuleMissing", async () => {
  const bare = createScope();
  const result = await bare.settle(api.greet, { input: { name: "x" } });

  expect(Object(result).error.kind).toBe("CapsuleMissing");
  await bare.close();
});

test("an unknown address is 404; a foreign origin is 403", async () => {
  expect((await raw(JSON.stringify([{ i: 1, a: "nope", t: "{}" }]))).e).toBe(404);
  const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13" };
  const evil = await fetch(base.replace("ws:", "http:"), {
    headers: {
      ...upgrade,
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      origin: "https://evil.example",
    },
  });
  expect(evil.status).toBe(403);
});

test("a bound public origin is the one a socket must come from, over an http request URL", async () => {
  /** 101 when the upgrade would go ahead; else the answer's status. */
  const open = async (origin: string | undefined, headers: Record<string, string>) => {
    const proxied = serverWith({ origin });
    await proxied.ready;
    const reply = proxied
      .resolve(server.server)
      .upgrade(new Request("http://app.example/rpc", { headers }), proxied, {
        upgrade: () => true,
      } as never);
    await proxied.close();
    return reply === null ? 101 : reply?.status;
  };

  expect(await open("https://app.example", { origin: "https://app.example" })).toBe(101);
  expect(await open("https://app.example", { origin: "https://evil.example" })).toBe(403);
  // Bound, the request URL's own origin no longer counts.
  expect(await open("https://app.example", { origin: "http://app.example" })).toBe(403);
  expect(await open("https://app.example", {})).toBe(101);
  // Unset, the request URL's origin is the one, as before.
  expect(await open(undefined, { origin: "http://app.example" })).toBe(101);
  expect(await open(undefined, { origin: "https://app.example" })).toBe(403);
});

test("a reply key never runs from a watch: nothing runs, the watch answers 404", async () => {
  spans.length = 0;
  expect((await raw(greetFrame("x", { w: 1 }))).e).toBe(404);
  expect(spans).not.toContain("greet.here");
});

test("a bound origin that is not an http(s) URL fails start, naming origin", async () => {
  const failureOf = async (origin: string) => {
    const bad = serverWith({ origin });
    const failure = await bad.ready.then(
      () => undefined,
      (error: unknown) => error,
    );
    await bad.close();
    return { origin, kind: Object(failure).kind, payload: Object(failure).payload };
  };

  // No scheme, a file URL (its origin is "null"), another scheme, garbage, and "null" itself.
  const origins = ["app.example", "file:///x", "ftp://app.example", "not a url", "null"];
  expect(await Promise.all(origins.map(failureOf))).toEqual(
    origins.map((origin) => ({
      origin,
      kind: "MissingConfig",
      payload: { label: "ws.server", key: "origin" },
    })),
  );
});

test("a key with no implementation fails start, naming it; no request is ever served", async () => {
  const missing = createScope({
    capsules: [
      more({ implement: { refuse: refuseHere } as never }),
      server.server({ path: "/rpc", services: [more] }),
    ],
  });

  const failure = await missing.ready.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(Object(failure).kind).toBe("MissingConfig");
  expect(Object(failure).payload).toEqual({ label: "rpc", key: "implement.crash" });
  await missing.close();
});

test("a frame over maxPayload (1 MiB unset) closes the socket (1009) and runs nothing", async () => {
  spans.length = 0;
  expect((await raw(greetFrame("a".repeat(1_048_576)))).closed).toBe(1009);
  expect(spans).not.toContain("greet.here");
  expect((await raw(greetFrame("a".repeat(1_000_000)))).t).toContain("Hello");
});

test("a bound smaller maxPayload is the cap", async () => {
  const small = serverWith({ maxPayload: 64 });
  await small.ready;
  const door = listen(small, [server.server]);
  const at = `${door.url}/rpc`;

  expect((await raw(greetFrame("a".repeat(40)), at)).closed).toBe(1009);
  expect((await raw(greetFrame("a"), at)).t).toContain("Hello");
  await door.bun.stop(true);
  await small.close();
});

test("a maxPayload that is not a positive whole number fails start, naming ws.maxPayload", async () => {
  const failureOf = async (maxPayload: number) => {
    try {
      await serverWith({ maxPayload }).close();
      return { maxPayload, kind: undefined, label: undefined };
    } catch (error) {
      const { kind, payload } = Object(error);
      return { maxPayload, kind, label: Object(payload).label };
    }
  };

  // NaN is what `Number(env.X)` gives for an unset or bad value: it would turn the cap off.
  const values = [Number.NaN, 0, -1, 1.5, Infinity];
  expect(await Promise.all(values.map(failureOf))).toEqual(
    values.map((maxPayload) => ({
      maxPayload,
      kind: "DataValidationFailed",
      label: "ws.maxPayload",
    })),
  );
});

test("a frame that is not JSON closes the socket (1008); a bad call text is the decode fault", async () => {
  expect((await raw("{not json")).closed).toBe(1008);
  const bad = await raw(JSON.stringify([{ i: 1, a: "greet", t: '{"name":' }]));
  expect(JSON.parse(bad.t!)).toEqual({ ok: false, kind: "decode", payload: { side: "server" } });
});
