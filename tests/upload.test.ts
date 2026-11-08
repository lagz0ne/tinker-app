import { afterAll, expect, test } from "bun:test";

import { createScope, operation } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { hook } from "~/components/protocol";
import { bytes, rpc } from "~/components/rpc";
import { ws } from "~/components/ws";
import { ws as wsServer } from "~/components/ws/index.server";

// Bytes beside the socket (Q7 A): a key with a `bytes(...)` field goes on its own POST,
// `/rpc/<address>`, and the server checks it before it reads one byte. Each guard has a case.

const api = rpc({
  "file.put": {
    input: z.object({
      name: z.string(),
      file: bytes({ max: 1024, types: ["application/octet-stream", "text/plain"] }),
    }),
    output: z.object({ name: z.string(), type: z.string(), text: z.string() }),
  },
  plain: { input: z.null(), output: z.literal("plain") },
});

/** The names the implementation ran for, in order. */
const ran: string[] = [];
const held = Promise.withResolvers<void>();

const put = operation({
  label: "file.put.here",
  input: api["file.put"].input,
  run: async (_, { input }) => {
    ran.push(input.name);
    if (input.name === "hold") await held.promise; // holds the POST open, the body unread
    return { name: input.name, type: input.file.type, text: await input.file.text() };
  },
});

const plain = operation({ label: "plain.here", input: z.null(), run: () => "plain" as const });

/** Refuses a call named "no", before the implementation and before the body. */
const gate = operation({
  label: "file.gate",
  input: hook.start,
  run: (_, { input }) =>
    Object(input.input).name === "no" ? input.refuse({ why: "no" }) : undefined,
});

const transport = wsServer.server({
  path: "/rpc",
  services: [api],
  maxUploads: 2,
  uploadDeadline: 300,
});

const backend = await createScope({
  capsules: [api({ implement: { "file.put": put, plain }, onStart: [gate] }), transport],
}).ready;

const door = backend.resolve(transport);

const bun = Bun.serve({
  port: 0,
  idleTimeout: 0,
  websocket: door.websocket as never,
  fetch: async (r, b) => {
    const reply = door.upgrade(r, backend, b as never);
    if (reply !== undefined) return reply ?? undefined;
    return (await door.post(r, backend)) ?? new Response(null, { status: 404 });
  },
});

const base = `localhost:${bun.port}/rpc`;

const browser = await createScope({
  capsules: [ws.client({ url: `ws://${base}` }), api({ remote: ws.client })],
}).ready;

afterAll(async () => {
  await browser.close();
  await bun.stop(true);
  await backend.close();
});

/** A POST as a browser would send it, with each header the test names. */
const post = (address: string, headers: Record<string, string>, body?: BodyInit) =>
  fetch(`http://${base}/${address}`, {
    method: "POST",
    headers: { "x-input": '{"name":"raw"}', "content-type": "text/plain", ...headers },
    body: body ?? "hi",
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);

test("a key with bytes runs from the client: the value as text, the bytes as the body", async () => {
  const file = new Blob(["hello"], { type: "text/plain" });
  expect(await browser.run(api["file.put"], { input: { name: "a", file } })).toEqual({
    name: "a",
    type: "text/plain",
    text: "hello",
  });

  // A type the key does not list goes as its first type.
  const png = new Blob(["png"], { type: "image/png" });
  expect(await browser.run(api["file.put"], { input: { name: "b", file: png } })).toEqual({
    name: "b",
    type: "application/octet-stream",
    text: "png",
  });
});

test("the memory transport carries the bytes as they are", async () => {
  const server = await createScope({
    capsules: [api({ implement: { "file.put": put, plain } }), memory.server({ services: [api] })],
  }).ready;
  const tab = await createScope({
    capsules: [memory.client({ peer: server }), api({ remote: memory.client })],
  }).ready;

  const file = new Blob(["in memory"], { type: "text/plain" });
  expect(await tab.run(api["file.put"], { input: { name: "m", file } })).toMatchObject({
    text: "in memory",
  });
  await tab.close();
  await server.close();
});

test("the guards answer before the body is read", async () => {
  ran.length = 0;
  const statuses = {
    plainKey: (await post("plain", {})).status,
    foreign: (await post("file.put", { origin: "https://evil.example" })).status,
    bigInput: (await post("file.put", { "x-input": "x".repeat(2049) })).status,
    bigMeta: (await post("file.put", { "x-meta": "x".repeat(2049) })).status,
    badMeta: (await post("file.put", { "x-meta": '{"n":1}' })).status,
    type: (await post("file.put", { "content-type": "text/html" })).status,
    tooLong: (await post("file.put", {}, "x".repeat(1025))).status,
  };
  const bare = await fetch(`http://${base}/file.put`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hi",
  });

  expect({ ...statuses, noInput: bare.status }).toEqual({
    plainKey: 404,
    foreign: 403,
    noInput: 400,
    bigInput: 431,
    bigMeta: 431,
    badMeta: 400,
    type: 415,
    tooLong: 413,
  });
  expect(ran).toEqual([]); // no guard let the implementation run
});

test("a body with no Content-Length is counted: past the max it is 413", async () => {
  const chunks = [new Uint8Array(600), new Uint8Array(600)];
  const stream = new ReadableStream<Uint8Array>({
    pull(out) {
      const next = chunks.shift();
      if (next) out.enqueue(next);
      else out.close();
    },
  });
  const answer = await post("file.put", { "content-type": "application/octet-stream" }, stream);
  expect(answer.status).toBe(413);
});

test("an onStart refusal answers refused, and the implementation never runs", async () => {
  ran.length = 0;
  const answer = await post("file.put", { "x-input": '{"name":"no"}' });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ ok: false, kind: "refused", payload: { why: "no" } });
  expect(ran).toEqual([]);
});

test("past maxUploads at once, the next POST is 503 with Retry-After", async () => {
  const hold = { "x-input": '{"name":"hold"}' };
  const first = [post("file.put", hold), post("file.put", hold)];
  await new Promise((r) => setTimeout(r, 50));
  const third = await post("file.put", {});

  expect([third.status, third.headers.get("retry-after")]).toEqual([503, "1"]);
  held.resolve();

  expect((await Promise.all(first)).map((each) => each.status)).toEqual([200, 200]);
});

test("a body that stalls is cut at the deadline: the call fails, the POST ends", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(out) {
      out.enqueue(new TextEncoder().encode("half"));
    },
  });
  const started = Date.now();
  const answer = await post("file.put", { "content-type": "application/octet-stream" }, stream);

  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ ok: false, kind: "failed", payload: {} });
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a bytes key sent as socket text has no bytes: it is invalid", async () => {
  const socket = new WebSocket(`ws://${base}`);
  const reply = await new Promise<string>((done) => {
    socket.onopen = () =>
      socket.send(JSON.stringify([{ i: 1, a: "file.put", t: '{"name":"s"}', m: {} }]));
    socket.onmessage = (e) => done(String(e.data));
  });
  socket.close();
  expect(JSON.parse(JSON.parse(reply)[0].t)).toEqual({ ok: false, kind: "invalid", payload: {} });
});

test("the host's body cap is the largest bytes key", () => {
  expect(door.maxBody).toBe(1024);
});

test("a bytes field is one per key, on a reply key, with a max and a type", () => {
  expect(() => bytes({ max: 0 })).toThrow();
  expect(() => bytes({ max: 10, types: [] })).toThrow();
  expect(() =>
    rpc({
      two: {
        input: z.object({ a: bytes({ max: 1 }), b: bytes({ max: 1 }) }),
        output: z.null(),
      },
    }),
  ).toThrow("one field at most");
});
