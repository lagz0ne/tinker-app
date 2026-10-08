import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { version } from "../package.json";
import { responseBodies } from "../src/backend/body.server";
import { health } from "../src/backend/health";
import entry from "../src/defaults/server";
import { devErrorPage } from "../src/entry/dev-error";
import { env, readResult } from "../src/server";
import { startRequests } from "../src/start";

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

/**
 * A request's finish: it ends the request once, as the start middleware's own finish does.
 * @param ends - From a test; why: each request's end, true when graceful.
 */
function endOnce(ends: boolean[]) {
  let ended: Promise<void> | undefined;
  return (graceful: boolean) =>
    (ended ??= Promise.resolve().then(() => {
      ends.push(graceful);
    }));
}

test("a held response body ends the request when read to the end, or when cancelled", async () => {
  const root = createScope();
  const ends: boolean[] = [];
  const read = await (
    await root.resolve(responseBodies)
  ).hold(new Response("hello"), endOnce(ends));
  expect(await read.text()).toBe("hello");
  const open = await (
    await root.resolve(responseBodies)
  ).hold(new Response(new ReadableStream()), endOnce(ends));
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

test("dev passes on any response that is not a page load's JSON 500", async () => {
  const page = new Request("http://app/", { headers: { accept: "text/html" } });
  const data = new Request("http://app/", { headers: { accept: "application/json" } });
  const failed = Response.json({ message: "boom" }, { status: 500 });
  expect(await devErrorPage(data, failed)).toBe(failed);
  const text = new Response("boom", { status: 500 });
  expect(await devErrorPage(page, text)).toBe(text);
  const bare = new Response(null, { status: 500 });
  expect(await devErrorPage(page, bare)).toBe(bare);
});

test("a response with no body ends its request at once and passes through", async () => {
  const root = createScope();
  const bodies = await root.resolve(responseBodies);
  const ends: boolean[] = [];
  const empty = new Response(null, { status: 204 });
  expect(await bodies.hold(empty, async (graceful) => void ends.push(graceful))).toBe(empty);
  expect(ends).toEqual([true]);
  expect(bodies.isResponse(empty)).toBe(true);
  expect(bodies.isResponse({ status: 204 })).toBe(false);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a held body keeps its status and headers, and ends its request once", async () => {
  const root = createScope();
  const ends: boolean[] = [];
  const held = await (
    await root.resolve(responseBodies)
  ).hold(
    new Response("made", { status: 201, statusText: "Made", headers: { "x-app": "1" } }),
    async (graceful) => void ends.push(graceful),
  );
  expect([held.status, held.statusText, held.headers.get("x-app")]).toEqual([201, "Made", "1"]);
  expect(await held.text()).toBe("made");
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(ends).toEqual([true]);
});

test("a body that fails to read ends its request by force and fails the read", async () => {
  const root = createScope();
  const ends: boolean[] = [];
  const torn = new Error("torn");
  const source = new ReadableStream({
    pull(controller) {
      controller.error(torn);
    },
  });
  const held = await (
    await root.resolve(responseBodies)
  ).hold(new Response(source), async (graceful) => void ends.push(graceful));
  await expect(held.text()).rejects.toBe(torn);
  expect(ends).toEqual([false]);
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(ends).toEqual([false]);
});

test("closing the scope cancels each open body and ends its request by force", async () => {
  const root = createScope();
  const ends: boolean[] = [];
  const cancelled: string[] = [];
  const bodies = await root.resolve(responseBodies);
  const open = () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.push("source");
        },
      }),
    );
  const left = await bodies.hold(open(), endOnce(ends));
  const dropped = await bodies.hold(open(), endOnce(ends));
  await dropped.body?.cancel();
  expect([ends, cancelled]).toEqual([[false], ["source"]]);
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect([ends, cancelled]).toEqual([
    [false, false],
    ["source", "source"],
  ]);
  expect(left.bodyUsed).toBe(false);
});

test("a request that cannot end fails the body's cancel, and the scope's close", async () => {
  const root = createScope();
  const lost = new Error("lost");
  const bodies = await root.resolve(responseBodies);
  const cancelled = await bodies.hold(new Response(new ReadableStream()), async () => {
    throw lost;
  });
  await expect(cancelled.body?.cancel()).rejects.toBe(lost);
  await bodies.hold(new Response(new ReadableStream()), async () => {
    throw lost;
  });
  expect((await root.close({ graceful: true })).teardownErrors).toEqual([lost]);
});
