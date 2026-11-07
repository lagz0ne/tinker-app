import { afterAll, expect, test } from "bun:test";

import { createScope, operation, resource } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { rpc } from "~/components/rpc";

// The implementation runs in its own layer, so a session-target resource (a transaction) ends
// with the implementation's own result: committed on success, rolled back on a throw. The
// request session's close is not the outcome (Hedl found this: writes ended "cancelled").

const ends: string[] = [];

const transaction = resource({
  label: "transaction",
  target: "session",
  factory: (_deps, { defer }) => {
    defer((end) => void ends.push(end.status));
    return {};
  },
});

const ok = operation({
  label: "ok.here",
  input: z.null(),
  depends: { tx: transaction },
  run: async () => null,
});

const boom = operation({
  label: "boom.here",
  input: z.null(),
  depends: { tx: transaction },
  run: async (): Promise<null> => {
    throw new Error("half written");
  },
});

const api = rpc({
  ok: { input: z.null(), output: z.null() },
  boom: { input: z.null(), output: z.null() },
});

const server = createScope({
  capsules: [api({ implement: { ok, boom } }), memory.server({ services: [api] })],
});

await server.ready;

const client = createScope({
  capsules: [memory.client({ peer: server }), api({ remote: memory.client })],
});

await client.ready;

afterAll(async () => {
  await client.close();
  await server.close();
});

test("over the wire: success commits, a throw rolls back", async () => {
  ends.length = 0;
  await client.run(api.ok, { input: null });
  await client.run(api.boom, { input: null }).catch(() => undefined);

  expect(ends).toEqual(["success", "failed"]);
});

test("in process: the same rule", async () => {
  ends.length = 0;
  await server.run(api.ok, { input: null });
  await server.run(api.boom, { input: null }).catch(() => undefined);

  expect(ends).toEqual(["success", "failed"]);
});
