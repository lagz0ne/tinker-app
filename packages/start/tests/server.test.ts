import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { version } from "../package.json";
import { responseBodies } from "../src/backend/body.server.ts";
import { health } from "../src/backend/health.ts";
import entry from "../src/defaults/server.ts";
import { devErrorPage } from "../src/entry/dev-error.ts";
import { env, readResult } from "../src/server.ts";
import { startRequests } from "../src/start.ts";

const greet = operation({
  label: "test.greet",
  depends: { env },
  run: ({ env }) => `Hello, ${env.GREETING_NAME ?? "nobody"}.`,
});

const refuse = operation({
  label: "test.refuse",
  run: (_deps, { raise }) => raise("Refused", { why: "test" }),
});

test("readResult returns a settled value and throws a settled failure as is", async () => {
  const root = createScope({ tags: [env({ GREETING_NAME: "Ada" })] });
  expect(readResult(root.settle(greet))).toBe("Hello, Ada.");
  const failed = root.settle(refuse);
  expect(failed.status).toBe("failed");
  expect(() => readResult(failed)).toThrow(failed.status === "failed" ? failed.error : undefined);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("readResult turns a cancelled call into the base's Cancelled error", async () => {
  const root = createScope();
  const stop = new AbortController();
  stop.abort();
  const cancelled = await root.settle(greet, { signal: stop.signal });
  expect(cancelled.status).toBe("cancelled");
  expect(() => readResult(cancelled)).toThrow(expect.objectContaining({ kind: "Cancelled" }));
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the base's health operation reports the base version", async () => {
  const root = createScope();
  expect(readResult(root.settle(health))).toEqual({ ok: true, base: version });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the start extension hands each request its root scope", async () => {
  const root = createScope({ extensions: [startRequests] });
  await root.ready;
  expect(root.resolve(startRequests).scope).toBe(root);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a request with no root scope fails before any work runs", async () => {
  const run = startRequests.middleware.options.server;
  let called = false;
  await expect(
    run?.({
      request: new Request("http://app/"),
      pathname: "/",
      handlerType: "router",
      context: {},
      next() {
        called = true;
        return expect.unreachable("next must not run");
      },
    }),
  ).rejects.toMatchObject({ kind: "StartScopeMissing" });
  expect(called).toBe(false);
});

test("a held response body ends the request when read to the end, or when cancelled", async () => {
  const root = createScope();
  const ends: boolean[] = [];
  /** Each request ends once, as the start middleware's own finish does. */
  const request = () => {
    let ended: Promise<void> | undefined;
    return (graceful: boolean) =>
      (ended ??= Promise.resolve().then(() => {
        ends.push(graceful);
      }));
  };
  const read = await root.resolve(responseBodies).hold(new Response("hello"), request());
  expect(await read.text()).toBe("hello");
  const open = await root
    .resolve(responseBodies)
    .hold(new Response(new ReadableStream()), request());
  await open.body?.cancel();
  expect(ends).toEqual([true, false]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("with no src/server.ts, the server entry goes straight to the base", async () => {
  const reply = new Response("from the base");
  const response = await entry.fetch(new Request("http://app/"), async () => reply);
  expect(response).toBe(reply);
});

test("dev turns Start's JSON 500 into a page that reloads after the fix", async () => {
  const page = new Request("http://app/", { headers: { accept: "text/html" } });
  const failed = () => Response.json({ message: "<boom> & co" }, { status: 500 });
  const shown = await devErrorPage(page, failed());
  expect(shown.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(shown.status).toBe(500);
  const html = await shown.text();
  expect(html).toContain('{"message":"&lt;boom> &amp; co"}');
  expect(html).toContain('createHotContext("/@tinker/dev-error")');
  const data = failed();
  expect(await devErrorPage(new Request("http://app/_serverFn/x"), data)).toBe(data);
  const fine = new Response("ok");
  expect(await devErrorPage(page, fine)).toBe(fine);
});
