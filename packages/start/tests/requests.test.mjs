import { createScope, operation, resource } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { requestHeaders } from "../src/backend/headers.server.ts";
import { requestStop } from "../src/backend/lifetime.ts";
import { readResult } from "../src/server.ts";
import { startRequests } from "../src/start.ts";

/** Runs until its session stops it by force. */
const stoppable = operation({
  label: "test.stoppable",
  run: (_deps, { signal }) =>
    new Promise((done) => signal.addEventListener("abort", () => done("stopped"), { once: true })),
});

const asker = operation({
  label: "test.asker",
  depends: { requestHeaders, requestStop },
  run: ({ requestHeaders, requestStop }) => ({ who: requestHeaders.get("x-who"), requestStop }),
});

test("each request runs in its own session, with its headers and stop signal, until its body is read", async () => {
  const root = createScope();
  const closed = [];
  const closing = Promise.withResolvers();
  const recorder = resource({
    label: "test.recorder",
    target: "session",
    factory: (_deps, ctx) => {
      ctx.closing.addEventListener("abort", () => closing.resolve(), { once: true });
      ctx.defer(() => {
        closed.push("session");
      });
      return closed;
    },
  });
  const gate = Promise.withResolvers();
  const gated = operation({
    label: "test.gated",
    run: async (_deps, { signal }) => {
      await gate.promise;
      return signal.aborted;
    },
  });
  const request = new Request("http://app/", { headers: { "x-who": "Ada" } });
  let asked;
  const running = Promise.withResolvers();
  const result = await startRequests.middleware.options.server?.({
    request,
    pathname: "/",
    handlerType: "router",
    context: { scope: root },
    async next(options) {
      const context = options?.context ?? expect.unreachable("the middleware passes its context");
      asked = readResult(context.session.settle(asker));
      context.session.resolve(recorder);
      running.resolve(context.session.settle(gated));
      return { request, pathname: "/", context, response: new Response("hello") };
    },
  });
  expect(asked).toEqual({ who: "Ada", requestStop: request.signal });
  if (!result || result instanceof Response) return expect.unreachable("Start's result comes back");
  const reading = result.response.text();
  await closing.promise;
  expect(closed).toEqual([]);
  gate.resolve();
  expect(await reading).toBe("hello");
  expect(closed).toEqual(["session"]);
  expect(await running.promise).toEqual({ status: "success", value: false });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a request that throws stops its session by force and passes the error on", async () => {
  const root = createScope();
  const request = new Request("http://app/");
  const boom = new Error("boom");
  const running = Promise.withResolvers();
  await expect(
    startRequests.middleware.options.server?.({
      request,
      pathname: "/",
      handlerType: "router",
      context: { scope: root },
      async next(options) {
        const context = options?.context ?? expect.unreachable("the middleware passes its context");
        running.resolve(context.session.settle(stoppable));
        throw boom;
      },
    }),
  ).rejects.toBe(boom);
  expect(await running.promise).toEqual({ status: "success", value: "stopped" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a teardown error in the request session fails the body read", async () => {
  const root = createScope();
  const lost = new Error("lost");
  const leaky = resource({
    label: "test.leaky",
    target: "session",
    factory: (_deps, ctx) => {
      ctx.defer(() => {
        throw lost;
      });
      return 1;
    },
  });
  const request = new Request("http://app/");
  const result = await startRequests.middleware.options.server?.({
    request,
    pathname: "/",
    handlerType: "router",
    context: { scope: root },
    async next(options) {
      const context = options?.context ?? expect.unreachable("the middleware passes its context");
      context.session.resolve(leaky);
      return { request, pathname: "/", context, response: new Response("hello") };
    },
  });
  if (!result || result instanceof Response) return expect.unreachable("Start's result comes back");
  await expect(result.response.text()).rejects.toBe(lost);
  expect((await root.close({ graceful: true })).status).toBe("success");
});
