import { afterEach, expect, test } from "bun:test";

import { createScope, operation } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { rpc } from "~/components/rpc";

import { wsClient } from "./support/ws";

// A value or a text the codec cannot handle is its own fault: encode or decode, with the side.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const api = rpc({
  big: { input: z.null(), output: z.object({ n: z.bigint() }) }, // JSON cannot carry a BigInt
  echo: { input: z.object({ n: z.unknown() }), output: z.unknown() },
});

const big = operation({ label: "big.do", input: z.null(), run: async () => ({ n: 1n }) });

const echo = operation({
  label: "echo.do",
  input: z.object({ n: z.unknown() }),
  run: async (_, { input }) => input.n,
});

async function pair() {
  const lines: string[] = [];
  const traces: Record<string, string | undefined> = {};
  const spans: Array<{ name: string; traceId: string }> = [];
  const server = createScope({
    observe: {
      export: () => undefined,
      log: (l) =>
        void (lines.push(`${l.message} ${JSON.stringify(l.attributes)}`),
        (traces[`server ${l.message}`] = l.span?.traceId)),
    },
    capsules: [api({ implement: { big, echo } }), memory.server({ services: [api] })],
  });
  await server.ready;
  closers.push(() => server.close());
  const client = createScope({
    observe: {
      export: (x) => void spans.push(x),
      log: (l) =>
        void (lines.push(`${l.message} ${JSON.stringify(l.attributes)}`),
        (traces[`client ${l.message}`] = l.span?.traceId)),
    },
    capsules: [memory.client({ peer: server }), api({ remote: memory.client })],
  });
  await client.ready;
  closers.push(() => client.close());

  return { server, client, lines, traces, spans };
}

const faultOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (api.fault.is(e) ? { fault: e.fault, payload: e.payload } : e),
  );

test("encode on the server: the output cannot be text; the client gets encode, side server", async () => {
  const { client, lines, traces, spans } = await pair();
  expect(await faultOf(client.run(api.big, { input: null }))).toEqual({
    fault: "encode",
    payload: { side: "server" },
  });
  expect(
    lines.some(
      (l) =>
        l.startsWith("protocol encode failed") &&
        l.includes('"address":"big"') &&
        l.includes('"side":"server"'),
    ),
  ).toBe(true);
  // The server's log line is in the client call's trace: one trace id across both sides.
  expect(traces["server protocol encode failed"]).toBeString();
  expect(traces["server protocol encode failed"]).toBe(
    spans.find((x) => x.name === "big")?.traceId,
  );
});

test("encode on the client: the input cannot be text; nothing is sent", async () => {
  const { client, lines } = await pair();
  expect(await faultOf(client.run(api.echo, { input: { n: 2n } }))).toEqual({
    fault: "encode",
    payload: { side: "client" },
  });
  expect(
    lines.some((l) => l.startsWith("protocol encode failed") && l.includes('"side":"client"')),
  ).toBe(true);
  expect(lines.some((l) => l.includes('"side":"server"'))).toBe(false);
});

test("decode on the server: a text it cannot read answers decode, side server", async () => {
  const { server, lines } = await pair();
  const text = await server.run(memory.server.serve, {
    input: { address: "echo", text: "{not json", meta: {} },
  });
  expect(JSON.parse(text!)).toEqual({ ok: false, kind: "decode", payload: { side: "server" } });
  expect(
    lines.some((l) => l.startsWith("protocol decode failed") && l.includes('"address":"echo"')),
  ).toBe(true);
});

test("decode on the client: a reply it cannot read is decode, side client (not link)", async () => {
  // A server that answers each call with a page, not a reply text.
  const proxy = Bun.serve({
    port: 0,
    fetch: (r, b) => (b.upgrade(r) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      message: (ws, frame) =>
        void ws.send(
          JSON.stringify(
            (JSON.parse(String(frame)) as { i: number }[]).map(({ i }) => ({
              i,
              t: "<html>502 Bad Gateway</html>",
            })),
          ),
        ),
    },
  });
  closers.push(() => proxy.stop(true));
  const lines: string[] = [];
  const client = createScope({
    observe: { log: (l) => void lines.push(`${l.message} ${JSON.stringify(l.attributes)}`) },
    capsules: [
      wsClient.client({ url: `ws://localhost:${proxy.port}/api` }),
      api({ remote: wsClient.client }),
    ],
  });
  await client.ready;
  closers.push(() => client.close());

  expect(await faultOf(client.run(api.echo, { input: { n: 1 } }))).toEqual({
    fault: "decode",
    payload: { side: "client" },
  });
  expect(
    lines.some((l) => l.startsWith("protocol decode failed") && l.includes('"side":"client"')),
  ).toBe(true);
});

test("a client fault carries the call's trace id: the same id as the server's log line", async () => {
  const { client, traces, spans } = await pair();
  const error = await client.run(api.big, { input: null }).then(
    () => null,
    (e: unknown) => e,
  );
  if (!api.fault.is(error)) throw new Error("expected an rpc fault");

  expect(error.traceId).toBe(spans.find((x) => x.name === "big")?.traceId);
  expect(error.traceId).toBe(traces["server protocol encode failed"]);
  expect(error.message).toBe(`big: encode (trace ${error.traceId})`);
});

test("F40: a Core kind (DataValidationFailed, from a bad output) does not cross: the client gets failed", async () => {
  const wrong = rpc({ bad: { input: z.null(), output: z.object({ n: z.number() }) } });
  const bad = operation({
    label: "bad.do",
    input: z.null(),
    run: async () => ({ n: "not a number" }) as never,
  });
  const server = createScope({
    capsules: [wrong({ implement: { bad } }), memory.server({ services: [wrong] })],
  });
  await server.ready;
  closers.push(() => server.close());
  const text = await server.run(memory.server.serve, {
    input: { address: "bad", text: "null", meta: {} },
  });

  expect(JSON.parse(text!)).toEqual({ ok: false, kind: "failed", payload: {} });
});
