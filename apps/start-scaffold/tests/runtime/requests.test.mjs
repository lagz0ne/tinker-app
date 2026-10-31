import { createServer, get } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createScope, operation, resource } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { requestStop, startRequests } from "~/components/requests";
import { requestHeaders, renderFrames } from "~/components/requests/index.server";

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

/**
 * Serves one route the way `tinker serve` does: hono's Node listener, with the Node response
 * lent on `request.runtime`. The route gets the request's session.
 * @param root - From a test; why: the app scope each request session comes from.
 * @param route - From a test; why: the work and the response for one request.
 */
async function serveHosted(root, route) {
  const listener = getRequestListener(async (request, { incoming, outgoing }) => {
    request.runtime = { name: "node", node: { req: incoming, res: outgoing } };
    const result = await startRequests.middleware.options.server({
      request,
      pathname: "/",
      handlerType: "router",
      context: { scope: root },
      next: async ({ context }) => ({ request, pathname: "/", context, ...route(context) }),
    });
    return writeHosted(request, result.response, outgoing);
  });
  const server = createServer(listener).listen(0);
  await new Promise((done) => server.once("listening", done));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/**
 * The host's side of the join: write the body, await the lent `beforeEnd`, then end; a failed
 * join destroys the reply.
 * @param request - From serveHosted; why: the join the middleware lends.
 * @param response - From the middleware; why: the reply to write.
 * @param outgoing - From hono; why: the Node response.
 */
async function writeHosted(request, response, outgoing) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.flushHeaders();
  try {
    for await (const part of response.body ?? []) outgoing.write(part);
    await request.runtime.beforeEnd?.();
    outgoing.end();
  } catch (error) {
    outgoing.destroy(error);
  }
  return RESPONSE_ALREADY_SENT;
}

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
      asked = context.session.settle(asker);
      context.session.resolve(recorder);
      running.resolve(context.session.settle(gated));
      return { request, pathname: "/", context, response: new Response("hello") };
    },
  });

  expect(asked).toEqual({
    status: "success",
    value: { who: "Ada", requestStop: request.signal },
  });
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

test("cancelling a body stops active request work before it can close gracefully", async () => {
  const root = createScope();
  const started = Promise.withResolvers();
  const running = Promise.withResolvers();
  const waiting = operation({
    label: "test.waiting",
    run: async (_deps, { signal }) => {
      await new Promise((done) => {
        signal.addEventListener("abort", () => done(), { once: true });
        started.resolve();
      });
      signal.throwIfAborted();
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
      running.resolve(context.session.settle(waiting));
      return { request, pathname: "/", context, response: new Response(new ReadableStream()) };
    },
  });
  if (!result || result instanceof Response) return expect.unreachable("Start's result comes back");

  await started.promise;
  await result.response.body.cancel();

  expect((await running.promise).status).toBe("cancelled");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test.each(["end", "cancel", "error"])(
  "one body hold closes render and request before %s returns",
  async (ending) => {
    const root = createScope();
    const request = new Request("http://app/");
    const closed = [];
    const render = createScope();
    render.resolve(
      resource({
        label: "test.render-close",
        factory: (_deps, ctx) => {
          ctx.defer(() => {
            closed.push("render");
          });
        },
      }),
    );

    const recorder = resource({
      label: "test.request-close",
      target: "session",
      factory: (_deps, ctx) => {
        ctx.defer(() => {
          closed.push("request");
        });
      },
    });

    const torn = new Error("source failed");
    const source =
      ending === "end"
        ? new Response("page")
        : new Response(
            new ReadableStream({
              pull(controller) {
                if (ending === "error") controller.error(torn);
              },
            }),
          );
    const result = await startRequests.middleware.options.server({
      request,
      pathname: "/",
      handlerType: "router",
      context: { scope: root },
      async next(options) {
        options.context.session.resolve(recorder);
        root.resolve(renderFrames).retain(request, async () => {
          await render.close({ graceful: true });
        });
        return { request, pathname: "/", context: options.context, response: source };
      },
    });

    expect(closed).toEqual([]);
    if (ending === "cancel") await result.response.body.cancel();
    else if (ending === "error") await expect(result.response.text()).rejects.toBe(torn);
    else expect(await result.response.text()).toBe("page");

    expect(closed).toEqual(["request", "render"]);
    expect((await render.close({ graceful: true })).status).toBe("success");
    expect((await root.close({ graceful: true })).status).toBe("success");
  },
);

test("a hosted request closes its session gracefully before the host ends its response", async () => {
  const root = createScope();
  const closing = Promise.withResolvers();
  const closed = [];
  const recorder = resource({
    label: "test.recorder",
    target: "session",
    factory: (_deps, ctx) => {
      ctx.closing.addEventListener("abort", () => closing.resolve(), { once: true });
      ctx.defer(() => {
        closed.push("session");
      });
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
  const running = Promise.withResolvers();
  const { server, url } = await serveHosted(root, ({ session }) => {
    session.resolve(recorder);
    running.resolve(session.settle(gated));
    return { response: new Response("hello") };
  });

  const reply = fetch(url);
  await closing.promise;
  gate.resolve();

  expect(await (await reply).text()).toBe("hello");
  expect(closed).toEqual(["session"]);
  expect(await running.promise).toEqual({ status: "success", value: false });
  await new Promise((done) => server.close(done));
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a client abort ends a hosted request session by force, once", async () => {
  const root = createScope();
  const closed = [];
  const recorder = resource({
    label: "test.recorder",
    target: "session",
    factory: (_deps, ctx) => {
      ctx.defer(() => {
        closed.push("session");
      });
    },
  });
  const running = Promise.withResolvers();
  const { server, url } = await serveHosted(root, ({ session }) => {
    session.resolve(recorder);
    running.resolve(session.settle(stoppable));
    return { response: new Response(new ReadableStream()) };
  });

  get(url, (res) => res.destroy()).on("error", () => {});

  expect(await running.promise).toEqual({ status: "success", value: "stopped" });
  await new Promise((done) => server.close(done));
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(closed).toEqual(["session"]);
});

test("closing the app destroys each open hosted response", async () => {
  const root = createScope();
  const { server, url } = await serveHosted(root, () => ({
    response: new Response(new ReadableStream()),
  }));
  const answered = Promise.withResolvers();
  const ended = Promise.withResolvers();

  get(url, (res) => {
    answered.resolve();
    res.on("close", () => ended.resolve(res.complete)).resume();
  }).on("error", () => {});
  await answered.promise;

  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(await ended.promise).toBe(false);
  await new Promise((done) => server.close(done));
});

test("a request that cannot close fails its hosted reply", async () => {
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
  const { server, url } = await serveHosted(root, ({ session }) => {
    session.resolve(leaky);
    return { response: new Response("hello") };
  });

  await expect((await fetch(url)).text()).rejects.toThrow("terminated");
  await new Promise((done) => server.close(done));
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a request that cannot end after a client abort fails the app close", async () => {
  const root = createScope();
  const lost = new Error("lost");
  const ran = Promise.withResolvers();
  const leaky = resource({
    label: "test.leaky",
    target: "session",
    factory: (_deps, ctx) => {
      ctx.defer(() => {
        ran.resolve();
        throw lost;
      });
      return 1;
    },
  });
  const { server, url } = await serveHosted(root, ({ session }) => {
    session.resolve(leaky);
    return { response: new Response(new ReadableStream()) };
  });

  get(url, (res) => res.destroy()).on("error", () => {});
  await ran.promise;
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => server.close(done));

  expect((await root.close({ graceful: true })).teardownErrors).toEqual([lost]);
});
