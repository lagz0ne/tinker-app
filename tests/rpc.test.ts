import { afterAll, expect, test } from "bun:test";

import { createScope, isError, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { hook } from "~/components/protocol";
import { rpc } from "~/components/rpc";
import { sse as tab } from "~/components/sse";
import { sse as server } from "~/components/sse/index.server";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";

// The template app's api over SSE, and the HTTP rules of sse.server: origin, maxBody.

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
    server.server({ base: "/rpc", services: [api, more] }),
  ],
});

await backend.ready;
const answer = backend.resolve(server.server);

const http = Bun.serve({
  port: 0,
  fetch: async (r) => (await answer(r, backend)) ?? new Response(null, { status: 404 }),
});

const browser = createScope({
  capsules: [
    tab.client({ base: `${http.url}rpc` }),
    api({ remote: tab.client }),
    more({ remote: tab.client }),
  ],
});

await browser.ready;

afterAll(async () => {
  await browser.close();
  await http.stop();
  await backend.close();
});

/** A server root with one more bound option, for the HTTP rules. */
const serverWith = (options: { origin?: string; maxBody?: number }) =>
  createScope({
    capsules: [
      api({ implement: { greet: greetHere } }),
      server.server({ base: "/rpc", services: [api], ...options }),
    ],
  });

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
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${http.url}rpc/${path}`, { method: "POST", body: "{}", headers });

  expect((await post("nope")).status).toBe(404);
  expect((await post("greet", { origin: "https://evil.example" })).status).toBe(403);
});

test("a bound public origin is the one a call must come from, over an http request URL", async () => {
  const call = async (origin: string | undefined, headers: Record<string, string>) => {
    const proxied = serverWith({ origin });
    await proxied.ready;
    const reply = await proxied.resolve(server.server)(
      new Request("http://app.example/rpc/greet", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Duke" }),
      }),
      proxied,
    );
    await proxied.close();
    return reply?.status;
  };

  expect(await call("https://app.example", { origin: "https://app.example" })).toBe(200);
  expect(await call("https://app.example", { origin: "https://evil.example" })).toBe(403);
  // Bound, the request URL's own origin no longer counts.
  expect(await call("https://app.example", { origin: "http://app.example" })).toBe(403);
  expect(await call("https://app.example", {})).toBe(200);
  // Unset, the request URL's origin is the one, as before.
  expect(await call(undefined, { origin: "http://app.example" })).toBe(200);
  expect(await call(undefined, { origin: "https://app.example" })).toBe(403);
});

test("a watch (GET) checks the origin too", async () => {
  const reply = await fetch(`${http.url}rpc/greet?text=null`, {
    headers: { origin: "https://evil.example" },
  });

  expect(reply.status).toBe(403);
});

test("a reply key never runs from a GET or another method: a link on another site changes nothing", async () => {
  spans.length = 0;
  const watch = await fetch(`${http.url}rpc/greet?text=${encodeURIComponent('{"name":"x"}')}`);
  const stream = await watch.text();
  const other = await fetch(`${http.url}rpc/greet`, { method: "DELETE", body: '{"name":"x"}' });

  expect(stream).not.toContain("data:"); // not this key's mode: nothing runs, nothing is sent
  expect(other.status).toBe(405);
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
      payload: { label: "sse.server", key: "origin" },
    })),
  );
});

test("a key with no implementation fails start, naming it; no request is ever served", async () => {
  const missing = createScope({
    capsules: [
      more({ implement: { refuse: refuseHere } as never }),
      server.server({ base: "/rpc", services: [more] }),
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

/** A greet call whose JSON body is exactly `bytes` long. */
const sized = (bytes: number) => JSON.stringify({ name: "a".repeat(bytes - '{"name":""}'.length) });

test("a body over maxBody (1 MiB unset) answers 413 and runs no implementation; at the cap is 200", async () => {
  const post = (body: string) => fetch(`${http.url}rpc/greet`, { method: "POST", body });

  spans.length = 0;
  expect((await post(sized(1_048_577))).status).toBe(413);
  expect(spans).not.toContain("greet.here");

  expect((await post(sized(1_048_576))).status).toBe(200);
  expect(spans).toContain("greet.here");
});

test("a body with no content-length is read only up to maxBody, then 413", async () => {
  const chunk = new Uint8Array(65_536).fill(0x20);
  let pulled = 0;
  // 4 MiB of JSON whitespace, then `{}`: valid JSON, so only the cap stops it.
  const body = new ReadableStream<Uint8Array>({
    pull: (stream) => {
      if (pulled >= 64 * chunk.byteLength) return stream.close();
      pulled += chunk.byteLength;
      stream.enqueue(pulled === 64 * chunk.byteLength ? new TextEncoder().encode("{}") : chunk);
    },
  });
  const request = new Request(`${http.url}rpc/greet`, { method: "POST", body });
  expect(request.headers.has("content-length")).toBe(false);

  spans.length = 0;
  const response = await answer(request, backend);
  expect(response?.status).toBe(413);
  expect(pulled).toBeLessThanOrEqual(1_048_576 + 2 * chunk.byteLength);
  expect(spans).not.toContain("greet.here");
});

test("a bound smaller maxBody is the cap", async () => {
  const small = serverWith({ maxBody: 16 });
  await small.ready;
  const call = async (bytes: number) =>
    (
      await small.resolve(server.server)(
        new Request("http://app.example/rpc/greet", { method: "POST", body: sized(bytes) }),
        small,
      )
    )?.status;

  expect(await call(17)).toBe(413);
  expect(await call(16)).toBe(200);
  await small.close();
});

test("a maxBody that is not a positive whole number or Infinity fails start, naming sse.maxBody", async () => {
  const failureOf = async (maxBody: number) => {
    try {
      await serverWith({ maxBody }).close();
      return { maxBody, kind: undefined, label: undefined };
    } catch (error) {
      const { kind, payload } = Object(error);
      return { maxBody, kind, label: Object(payload).label };
    }
  };

  // NaN is what `Number(env.X)` gives for an unset or bad value: it would turn the cap off.
  const values = [Number.NaN, 0, -1, 1.5];
  expect(await Promise.all(values.map(failureOf))).toEqual(
    values.map((maxBody) => ({ maxBody, kind: "DataValidationFailed", label: "sse.maxBody" })),
  );
});

test("maxBody Infinity has no cap: a 3 MB body answers 200", async () => {
  const open = serverWith({ maxBody: Infinity });
  await open.ready;
  const response = await open.resolve(server.server)(
    new Request("http://app.example/rpc/greet", { method: "POST", body: sized(3_000_000) }),
    open,
  );

  expect(response?.status).toBe(200);
  await open.close();
});

test("a call body that errors mid-read answers the decode fault, as bad JSON does", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (stream) => {
      pulls += 1;
      if (pulls === 1) return stream.enqueue(new TextEncoder().encode('{"name":'));
      stream.error(new Error("connection reset"));
    },
  });

  const response = await answer(
    new Request(`${http.url}rpc/greet`, { method: "POST", body }),
    backend,
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    ok: false,
    kind: "decode",
    payload: { side: "server" },
  });
});
