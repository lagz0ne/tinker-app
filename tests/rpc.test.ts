import { afterAll, expect, test } from "bun:test";

import { createScope, isError, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import type { Errors } from "~/components/errors";
import { rpc as tab } from "~/components/rpc";
import { rpc as server } from "~/components/rpc/index.server";
import type { Providers } from "~/components/rpc/index.server";

import { greet } from "@/api/greet";
import { greetHere } from "@/backend/greet";

const refuse = operation({
  label: "refuse",
  input: z.object({ why: z.string() }),
  run: async (_deps, { raise }): Promise<void> => raise("RpcNoProvider", { label: "refuse" }),
});

const refuseHere = operation({
  label: "refuse.here",
  input: refuse.input,
  run: async (_deps, { input, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    return raise("Refused", { message: input.why });
  },
}) satisfies typeof refuse;

const api = { greet, refuse };
const provide = { greet: greetHere, refuse: refuseHere } satisfies Providers<typeof api>;

const spans: string[] = [];
const observe: Observe.Config = { export: (span) => void spans.push(span.name) };

const backend = createScope({
  observe,
  capsules: [server.server({ api, provide })],
});

await backend.ready;
const answer = backend.resolve(server.server);

const http = Bun.serve({
  port: 0,
  fetch: async (r) => (await answer(r, backend)) ?? new Response(null, { status: 404 }),
});

const browser = createScope({
  capsules: [tab.client({ api, base: `${http.url}rpc` })],
});

await browser.ready;

afterAll(async () => {
  await browser.close();
  await http.stop();
  await backend.close();
});

test("the tab runs the contract; the server's provider does the work", async () => {
  spans.length = 0;
  const reply = await browser.run(greet, { input: { name: "Duke" } });

  expect(reply).toEqual({ text: "Hello, Duke." });
  expect(spans).toContain("greet.here");
});

test("the server runs the same contract here, on its provider", async () => {
  expect(await backend.run(greet, { input: { name: "here" } })).toEqual({ text: "Hello, here." });
});

test("bad input fails with DataValidationFailed on the tab", async () => {
  const result = await browser.settle(greet, { rawInput: { name: "" } });

  spans.length = 0;
  expect(result.status).toBe("failed");
  expect(isError(Object(result).error, "DataValidationFailed")).toBe(true);
  expect(spans).not.toContain("greet.here");
});

test("a failure the provider raises keeps its kind and payload over the wire", async () => {
  const result = await browser.settle(refuse, { input: { why: "no" } });

  const error = Object(result).error;
  expect(error.kind).toBe("Refused");
  expect(error.payload).toEqual({ message: "no" });
});

test("with no rpc capsule, the contract says it has no provider", async () => {
  const bare = createScope();
  const result = await bare.settle(greet, { input: { name: "x" } });

  expect(Object(result).error.kind).toBe("RpcNoProvider");
  await bare.close();
});

test("an unknown label is 404; a foreign origin is 403", async () => {
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${http.url}rpc/${path}`, { method: "POST", body: "{}", headers });

  expect((await post("nope")).status).toBe(404);
  expect((await post("greet", { origin: "https://evil.example" })).status).toBe(403);
});

test("a bound public origin is the one a call must come from, over an http request URL", async () => {
  const call = async (origin: string | undefined, headers: Record<string, string>) => {
    const proxied = createScope({ capsules: [server.server({ api, provide, origin })] });
    await proxied.ready;
    const reply = await proxied.resolve(server.server)(
      new Request("http://app.example/rpc/greet", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
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

test("a bound origin that is not an http(s) URL fails start, naming rpc.origin", async () => {
  const failureOf = async (origin: string) => {
    const bad = createScope({ capsules: [server.server({ api, provide, origin })] });
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
      payload: { label: "rpc", key: "origin" },
    })),
  );
});

test("a contract with no provider fails start, naming it; no request is ever served", async () => {
  const missing = createScope({
    capsules: [server.server({ api, provide: { greet: greetHere } as unknown as typeof provide })],
  });

  const failure = await missing.ready.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(Object(failure).kind).toBe("MissingConfig");
  expect(Object(failure).payload).toEqual({ label: "rpc", key: "provide.refuse" });
  await missing.close();
});

test("a contract under another key than its label fails start", async () => {
  const renamed = createScope({
    capsules: [server.server({ api: { hello: greet }, provide: { hello: greetHere } })],
  });

  const failure = await renamed.ready.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(Object(failure).payload).toEqual({ label: "rpc", key: "api.hello" });
  await renamed.close();
});

/** A greet call whose JSON body is exactly `bytes` long. */
const sized = (bytes: number) => JSON.stringify({ name: "a".repeat(bytes - '{"name":""}'.length) });

test("a body over rpc.maxBody (1 MiB unset) answers 413 and runs no provider; at the cap is 200", async () => {
  const post = (body: string) =>
    fetch(`${http.url}rpc/greet`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });

  spans.length = 0;
  expect((await post(sized(1_048_577))).status).toBe(413);
  expect(spans).not.toContain("greet.here");

  expect((await post(sized(1_048_576))).status).toBe(200);
  expect(spans).toContain("greet.here");
});

test("a body with no content-length is read only up to rpc.maxBody, then 413", async () => {
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

test("a bound smaller rpc.maxBody is the cap", async () => {
  const small = createScope({ capsules: [server.server({ api, provide, maxBody: 16 })] });
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
