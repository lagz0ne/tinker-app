import { test, expect } from "vite-plus/test";
import { createScope, operation, extension } from "@tinker/core";
import { startRequests, holdResponse, readResult } from "@tinker-start-scaffold/transport";
import { isError, raise } from "@tinker-start-scaffold/backend";

const waitForCancellation = operation({
  label: "test.waitForCancellation",
  run: async (_deps, ctx: import("@tinker/core").Operation.Ctx<() => void>) => {
    await new Promise<void>((done) => {
      ctx.signal.addEventListener("abort", () => done(), { once: true });
      ctx.input();
    });
    ctx.signal.throwIfAborted();
  },
});

test("an unbound Start request fails before next or session creation", async () => {
  const run = startRequests.middleware.options.server;
  expect.assertions(1);
  if (!run) raise("BadInput", { reason: "native middleware has no server callback" });
  let called = false;
  try {
    await run({
      request: new Request("http://localhost/"),
      pathname: "/",
      handlerType: "router",
      context: {},
      next() {
        called = true;
        raise("BadInput", { reason: "next must not run" });
      },
    });
  } catch (error) {
    if (!isError(error, "StartScopeMissing")) throw error;
    expect(called).toBe(false);
  }
});

test("the request stays open until its stream ends or is cancelled", async () => {
  let ended = 0;
  const track = extension({
    label: "test.requests",
    hooks: {
      async session(event) {
        const result = await event.next();
        ended += 1;
        return result;
      },
    },
  });
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal, extensions: [startRequests, track] });
  await root.ready;
  try {
    const session = root.createSession();
    const response = await holdResponse(new Response("hello"), async (graceful) => {
      await session.close({ graceful });
    });
    expect(ended).toBe(0);
    expect(await response.text()).toBe("hello");
    expect(ended).toBe(1);
    const second = root.createSession();
    const cancelled = await holdResponse(new Response(new ReadableStream()), async (graceful) => {
      await second.close({ graceful });
    });
    await cancelled.body?.cancel();
    expect(ended).toBe(2);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("cancelling a body aborts active work before a pending pull can close gracefully", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal });
  await root.ready;
  try {
    const session = root.createSession();
    const started = Promise.withResolvers<void>();
    const work = session
      .settle(waitForCancellation, { input: () => started.resolve() })
      .then(readResult)
      .then(
        () => "completed",
        (error: unknown) => {
          if (!isError(error, "Cancelled")) throw error;
          return "cancelled";
        },
      );
    await started.promise;
    const response = await holdResponse(new Response(new ReadableStream()), async (graceful) => {
      await session.close({ graceful });
    });
    await response.body?.cancel();
    expect(await work).toBe("cancelled");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
}, 1000);
