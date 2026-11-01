import { expect, test } from "bun:test";

import { createScope, operation } from "@tinker/core";
import { z } from "zod";

import { routes } from "~/components/requests/index.server";

const echo = operation({
  label: "echo",
  input: z.object({ id: z.string(), q: z.string() }),
  run: (_deps, { input }) => input,
});

const empty = operation({ label: "empty", run: () => undefined });
const raw = operation({ label: "raw", run: () => new Response("ok", { status: 201 }) });

const boom = operation({
  label: "boom",
  run: () => {
    throw new Error("boom");
  },
});

const slow = operation({
  label: "slow",
  run: (_deps, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
});

test("each route reply maps to its HTTP status", async () => {
  const stop = new AbortController();
  const app = createScope({
    capsules: [
      routes({
        stop: stop.signal,
        table: {
          "GET /x/{id}": echo,
          "POST /empty": empty,
          "GET /raw": raw,
          "GET /boom": boom,
          "GET /slow": slow,
        },
      }),
    ],
  });
  await app.ready;
  const fetch = app.resolve(routes);
  const call = (path: string, init?: RequestInit) =>
    fetch(new Request(`http://t${path}`, init), app);

  const ok = await call("/x/7?q=a");
  expect(ok?.status).toBe(200);
  expect(await ok?.json()).toEqual({ id: "7", q: "a" });
  expect((await call("/x/7"))?.status).toBe(400);
  expect((await call("/empty", { method: "POST" }))?.status).toBe(204);
  expect((await call("/raw"))?.status).toBe(201);
  expect((await call("/boom"))?.status).toBe(500);
  expect(await call("/nope")).toBeUndefined();
  expect(await call("/empty")).toBeUndefined();

  const waiting = call("/slow");
  stop.abort();
  expect((await waiting)?.status).toBe(503);

  await app.close();
});
