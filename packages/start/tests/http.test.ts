import { expect, test } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { httpRequest } from "@tinker/start/server";
import { isError, raise } from "@tinker/start/testing";
import { backendStop, http, httpBackend, requestStop, startRequests } from "@tinker/start/testing";

const post = operation({
  label: "test.post",
  depends: { request: httpRequest.controller },
  run: ({ request }) =>
    request.run({ rawInput: { url: "https://example.test/x?secret=1", method: "POST" } }),
});

/** The fake waits for abort, like fetch against a server that never replies. */
function createHeldBackend() {
  const started = Promise.withResolvers<void>();
  return {
    started: started.promise,
    binding: httpBackend((_url, init) => {
      const signal = init?.signal;
      if (!signal) raise("StartScopeMissing", {});
      signal.throwIfAborted();
      return new Promise<Response>((_done, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started.resolve();
      });
    }),
  };
}

test("closing the HTTP resource aborts a request still in flight", async () => {
  const stop = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(
        (_url, init) =>
          new Promise<Response>((_done, reject) => {
            const signal = init?.signal;
            if (!signal) raise("StartScopeMissing", {});
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            started.resolve(signal);
          }),
      ),
    ],
  });
  await scope.ready;
  const result = scope
    .resolve(http)
    .send("https://example.test/held", {
      method: "GET",
      signal: new AbortController().signal,
    })
    .then(
      () => "completed",
      () => "aborted",
    );
  const signal = await started.promise;
  await scope.close({ graceful: true });
  expect(signal.aborted).toBe(true);
  expect(await result).toBe("aborted");
  expect((await scope.closed).status).toBe("success");
});

test("a bound HTTP backend gets the request and returns text without network", async () => {
  const calls: {
    url: Parameters<typeof fetch>[0];
    method?: string;
    headers: Headers;
    body: BodyInit | null | undefined;
    aborted: boolean;
  }[] = [];
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async (url, init) => {
        calls.push({
          url,
          method: init?.method,
          headers: new Headers(init?.headers),
          body: init?.body,
          aborted: init?.signal?.aborted ?? true,
        });
        return new Response("reply", { status: 201, headers: { "x-reply": "yes" } });
      }),
    ],
  });
  await scope.ready;
  try {
    expect(
      await scope.run(httpRequest, {
        rawInput: {
          url: "https://no-network.invalid/x",
          method: "POST",
          headers: { "x-request": "yes" },
          body: "hello",
        },
      }),
    ).toEqual({
      status: 201,
      headers: { "content-type": ["text/plain;charset=UTF-8"], "x-reply": ["yes"] },
      body: "reply",
    });
    expect(
      calls.map(({ headers, ...call }) => ({ ...call, headers: Object.fromEntries(headers) })),
    ).toEqual([
      {
        url: "https://no-network.invalid/x",
        method: "POST",
        headers: { "x-request": "yes" },
        body: "hello",
        aborted: false,
      },
    ]);
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("network failures keep method, path, and only cause name and code", async () => {
  const failures = [
    Object.assign(new TypeError("connection refused: https://example.test/x?token=hidden"), {
      code: "ECONNREFUSED",
      url: "https://example.test/x?token=hidden",
    }),
    new TypeError("fetch failed: https://example.test/x?token=hidden", {
      cause: Object.assign(new Error("DNS failed: https://example.test/x?token=hidden"), {
        code: "ENOTFOUND",
        url: "https://example.test/x?token=hidden",
      }),
    }),
  ];
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async () => {
        throw failures.shift();
      }),
    ],
  });
  await scope.ready;
  try {
    for (const cause of [
      { name: "TypeError", code: "ECONNREFUSED" },
      { name: "Error", code: "ENOTFOUND" },
    ]) {
      const result = await scope.settle(httpRequest, {
        rawInput: { url: "https://example.test/x?token=hidden", method: "GET" },
      });
      if (result.status !== "failed") throw result;
      if (!isError(result.error, "HttpRequestFailed")) throw result.error;
      expect(result.error.payload).toEqual({
        method: "GET",
        path: "/x",
        cause,
      });
    }
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("an abort failure keeps its numeric code without its message", async () => {
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async () => {
        throw new DOMException("abort at https://example.test/x?token=hidden", "AbortError");
      }),
    ],
  });
  await scope.ready;
  try {
    const result = await scope.settle(httpRequest, {
      rawInput: { url: "https://example.test/x?token=hidden", method: "GET" },
    });
    if (result.status !== "failed") throw result;
    if (!isError(result.error, "HttpRequestFailed")) throw result.error;
    expect(result.error.payload).toEqual({
      method: "GET",
      path: "/x",
      cause: { name: "AbortError", code: 20 },
    });
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("a string cause keeps the outer error name and code without private text", async () => {
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async () => {
        throw Object.assign(
          new TypeError("fetch failed: https://example.test/x?token=hidden", {
            cause: "DNS failed: https://example.test/x?token=hidden",
          }),
          { code: "ENOTFOUND", url: "https://example.test/x?token=hidden" },
        );
      }),
    ],
  });
  await scope.ready;
  try {
    const result = await scope.settle(httpRequest, {
      rawInput: { url: "https://example.test/x?token=hidden", method: "GET" },
    });
    if (result.status !== "failed") throw result;
    if (!isError(result.error, "HttpRequestFailed")) throw result.error;
    expect(result.error.payload).toEqual({
      method: "GET",
      path: "/x",
      cause: { name: "TypeError", code: "ENOTFOUND" },
    });
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("network failures keep readable cause fields when the other field has a wrong type", async () => {
  const failures = [
    Object.assign(
      new TypeError("https://example.test/x?token=hidden", {
        cause: { name: 42, code: "ENOTFOUND", message: "secret", url: "https://secret.test" },
      }),
      { code: "EFAIL" },
    ),
    Object.assign(
      new TypeError("https://example.test/x?token=hidden", {
        cause: { name: "LookupError", code: { message: "secret" }, url: "https://secret.test" },
      }),
      { code: "EFAIL" },
    ),
  ];
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async () => {
        throw failures.shift();
      }),
    ],
  });
  await scope.ready;
  try {
    for (const cause of [
      { name: "TypeError", code: "ENOTFOUND" },
      { name: "LookupError", code: "EFAIL" },
    ]) {
      const result = await scope.settle(httpRequest, {
        rawInput: { url: "https://example.test/x?token=hidden", method: "GET" },
      });
      if (result.status !== "failed") throw result;
      if (!isError(result.error, "HttpRequestFailed")) throw result.error;
      expect(result.error.payload).toEqual({ method: "GET", path: "/x", cause });
    }
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("closing the caller aborts HTTP body reading", async () => {
  const reading = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async (_url, init) => {
        const signal = init?.signal;
        if (!signal) raise("StartScopeMissing", {});
        return new Response(
          new ReadableStream(
            {
              start(controller) {
                signal.addEventListener(
                  "abort",
                  () => {
                    cancelled.resolve();
                    controller.error(signal.reason);
                  },
                  { once: true },
                );
              },
              pull() {
                reading.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      }),
    ],
  });
  await scope.ready;
  const session = scope.createSession();
  const result = session.settle(post);
  await reading.promise;
  await session.close({ graceful: false });
  await cancelled.promise;
  expect((await result).status).toBe("cancelled");
  stop.abort();
  expect((await scope.closed).status).toBe("success");
});

test("an HTTP method is normalized once for sending and spans", async () => {
  const methods: (string | undefined)[] = [];
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    observe: { history: 20 },
    tags: [
      httpBackend(async (_url, init) => {
        methods.push(init?.method);
        return new Response(null, { status: 204 });
      }),
    ],
  });
  await scope.ready;
  try {
    for (const method of ["patch", "x!#$%&'*+-.^_`|~09"])
      await scope.run(httpRequest, { rawInput: { url: "https://example.test/x", method } });
    expect(methods).toEqual(["PATCH", "X!#$%&'*+-.^_`|~09"]);
    expect(
      scope
        .spans()
        .filter((span) => span.kind === "manual")
        .map((span) => span.name),
    ).toEqual(["http PATCH /x", "http X!#$%&'*+-.^_`|~09 /x"]);
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("an HTTP method rejects non-token characters before sending", async () => {
  let sent = 0;
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async () => {
        sent += 1;
        return new Response(null, { status: 204 });
      }),
    ],
  });
  await scope.ready;
  try {
    for (const method of ["", "GE T", "GET\r\n", "MÉTHOD", "()"])
      expect(
        (await scope.settle(httpRequest, { rawInput: { url: "https://example.test/x", method } }))
          .status,
      ).toBe("failed");
    expect(sent).toBe(0);
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("HTTP replies keep each set-cookie value and joined repeated headers", async () => {
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(
        async () =>
          new Response(null, {
            headers: [
              ["set-cookie", "a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/"],
              ["set-cookie", "b=2; HttpOnly; Path=/"],
              ["x-repeat", "first"],
              ["x-repeat", "second"],
            ],
          }),
      ),
    ],
  });
  await scope.ready;
  try {
    const reply = await scope.run(httpRequest, {
      rawInput: { url: "https://example.test/x", method: "GET" },
    });
    expect(reply.headers).toEqual({
      "set-cookie": ["a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/", "b=2; HttpOnly; Path=/"],
      "x-repeat": ["first, second"],
    });
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

test("backend stop settles a server function's signalled HTTP call", async () => {
  const backend = createHeldBackend();
  const stop = new AbortController();
  const call = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    extensions: [startRequests],
    tags: [backend.binding, backendStop(stop.signal)],
  });
  await scope.ready;
  const session = scope.createSession();
  const sending = session.settle(post, { signal: call.signal });
  await backend.started;
  stop.abort();
  const closing = session.close({ graceful: true });
  const result = await sending;
  if (result.status !== "failed") throw result;
  if (!isError(result.error, "HttpRequestFailed")) throw result.error;
  expect(result.error.payload).toMatchObject({ method: "POST", path: "/x" });
  expect(call.signal.aborted).toBe(false);
  expect(await closing).toEqual({ status: "success" });
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

for (const shape of ["signal", "tags"]) {
  test(`backend stop settles HTTP in a root call with ${shape}`, async () => {
    const backend = createHeldBackend();
    const stop = new AbortController();
    const call = new AbortController();
    const scope = createScope({
      signal: stop.signal,
      tags: [backend.binding, backendStop(stop.signal)],
    });
    await scope.ready;
    const input = { url: "https://slow.test/x", method: "GET" };
    const sending =
      shape === "signal"
        ? scope.settle(httpRequest, { rawInput: input, signal: call.signal })
        : scope.settle(httpRequest, { rawInput: input, tags: requestStop(call.signal) });
    await backend.started;
    stop.abort();
    const result = await sending;
    if (result.status !== "failed") throw result;
    if (!isError(result.error, "HttpRequestFailed")) throw result.error;
    expect(result.error.payload).toMatchObject({ method: "GET", path: "/x" });
    expect(call.signal.aborted).toBe(false);
    expect(await scope.closed).toEqual({ status: "success" });
  }, 2000);
}

test("request end settles its tagged HTTP call and leaves siblings open", async () => {
  const first = createHeldBackend();
  const second = createHeldBackend();
  const stop = new AbortController();
  const request = new AbortController();
  const scope = createScope({ signal: stop.signal });
  await scope.ready;
  const session = scope.createSession({ tags: first.binding });
  const sibling = scope.createSession({ tags: second.binding });
  const input = { url: "https://slow.test/x", method: "GET" };
  const sending = session.settle(httpRequest, {
    rawInput: input,
    tags: requestStop(request.signal),
  });
  let siblingFinished = false;
  const other = sibling.settle(httpRequest, { rawInput: input }).then((end) => {
    siblingFinished = true;
    return end;
  });
  await first.started;
  await second.started;
  request.abort();
  const result = await sending;
  if (result.status !== "failed") throw result;
  if (!isError(result.error, "HttpRequestFailed")) throw result.error;
  expect(result.error.payload).toMatchObject({ method: "GET", path: "/x" });
  expect(await session.close({ graceful: true })).toEqual({ status: "success" });
  expect(siblingFinished).toBe(false);
  await sibling.close();
  expect((await other).status).toBe("cancelled");
  stop.abort();
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

test("ending the server function's call signal still cancels its HTTP work", async () => {
  const backend = createHeldBackend();
  const stop = new AbortController();
  const request = new AbortController();
  const scope = createScope({ signal: stop.signal, tags: backend.binding });
  await scope.ready;
  const session = scope.createSession({ tags: requestStop(request.signal) });
  const sending = session.settle(post, { signal: request.signal });
  await backend.started;
  request.abort();
  expect((await sending).status).toBe("cancelled");
  expect(await session.close({ graceful: true })).toEqual({ status: "success" });
  stop.abort();
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

for (const end of [backendStop, requestStop]) {
  test(`an HTTP request after ${end.label} ends fails before sending`, async () => {
    let sent = 0;
    const stop = new AbortController();
    const ended = new AbortController();
    const scope = createScope({
      signal: stop.signal,
      tags: httpBackend(async () => {
        sent += 1;
        return new Response("too late");
      }),
    });
    await scope.ready;
    ended.abort();
    try {
      const result = await scope.settle(httpRequest, {
        rawInput: { url: "https://slow.test/late", method: "GET" },
        tags: end(ended.signal),
      });
      if (result.status !== "failed") throw result;
      if (!isError(result.error, "HttpRequestFailed")) throw result.error;
      expect(result.error.payload).toMatchObject({ method: "GET", path: "/late" });
      expect(sent).toBe(0);
    } finally {
      stop.abort();
      expect(await scope.closed).toEqual({ status: "success" });
    }
  }, 2000);
}

test("forced root and session closes still cancel a never-answering HTTP request", async () => {
  for (const where of ["root", "session"]) {
    const backend = createHeldBackend();
    const stop = new AbortController();
    const scope = createScope({
      signal: stop.signal,
      extensions: [startRequests],
      tags: [backend.binding],
    });
    await scope.ready;
    const target = where === "root" ? scope : scope.createSession();
    const sending = target.settle(httpRequest, {
      rawInput: { url: "https://slow.test/x", method: "GET" },
    });
    await backend.started;
    const closing = target.close();
    expect((await sending).status).toBe("cancelled");
    expect((await closing).status).toBe("cancelled");
    stop.abort();
    expect((await scope.closed).status).toBe(where === "root" ? "cancelled" : "success");
  }
}, 2000);

test("backend stop settles HTTP while other running work finishes", async () => {
  const backend = createHeldBackend();
  const started = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<number>();
  const waiting = operation({
    label: "test.other-work",
    run: (_deps, { signal }) => {
      started.resolve(signal);
      return finish.promise;
    },
  });
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [backend.binding, backendStop(stop.signal)],
  });
  await scope.ready;
  const working = scope.run(waiting);
  const signal = await started.promise;
  const sending = scope.settle(httpRequest, {
    rawInput: { url: "https://slow.test/x", method: "GET" },
    signal: new AbortController().signal,
  });
  await backend.started;
  let closed = false;
  const closing = scope.closed.then((end) => {
    closed = true;
    return end;
  });
  stop.abort();
  const result = await sending;
  if (result.status !== "failed") throw result;
  if (!isError(result.error, "HttpRequestFailed")) throw result.error;
  expect(signal.aborted).toBe(false);
  expect(closed).toBe(false);
  finish.resolve(42);
  expect(await working).toBe(42);
  expect(await closing).toEqual({ status: "success" });
}, 2000);

test("a direct graceful session close settles a hung HTTP send without stop tags", async () => {
  const backend = createHeldBackend();
  const stop = new AbortController();
  const call = new AbortController();
  const scope = createScope({ signal: stop.signal, tags: backend.binding });
  await scope.ready;
  const session = scope.createSession();
  const sending = session.settle(post, { signal: call.signal });
  await backend.started;
  const closing = session.close({ graceful: true });
  const result = await sending;
  if (result.status !== "failed") throw result;
  if (!isError(result.error, "HttpRequestFailed")) throw result.error;
  expect(result.error.payload).toEqual({
    method: "POST",
    path: "/x",
    cause: { name: "AbortError", code: 20 },
  });
  expect(call.signal.aborted).toBe(false);
  expect(await closing).toEqual({ status: "success" });
  stop.abort();
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

test("a direct graceful root close reaches a session's hung HTTP send without stop tags", async () => {
  const backend = createHeldBackend();
  const stop = new AbortController();
  const scope = createScope({ signal: stop.signal, tags: backend.binding });
  await scope.ready;
  const session = scope.createSession();
  const sending = session.settle(post);
  await backend.started;
  const closing = scope.close({ graceful: true });
  const result = await sending;
  if (result.status !== "failed") throw result;
  if (!isError(result.error, "HttpRequestFailed")) throw result.error;
  expect(result.error.payload).toEqual({
    method: "POST",
    path: "/x",
    cause: { name: "AbortError", code: 20 },
  });
  expect(await closing).toEqual({ status: "success" });
  expect(await session.close({ graceful: true })).toEqual({ status: "success" });
}, 2000);

test("backendStop ends a pending HTTP send without closing its root", async () => {
  const backend = createHeldBackend();
  const stop = new AbortController();
  const backendEnd = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [backend.binding, backendStop(backendEnd.signal)],
  });
  await scope.ready;
  const session = scope.createSession();
  const sending = session.settle(post);
  await backend.started;
  backendEnd.abort();
  const result = await sending;
  if (result.status !== "failed") throw result;
  if (!isError(result.error, "HttpRequestFailed")) throw result.error;
  expect(result.error.payload).toEqual({
    method: "POST",
    path: "/x",
    cause: { name: "AbortError", code: 20 },
  });
  expect(scope.run(operation({ label: "test.still-open", run: () => "still open" }))).toBe(
    "still open",
  );
  expect(await session.close({ graceful: true })).toEqual({ status: "success" });
  stop.abort();
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

test("running work finishes on graceful close when the HTTP backend answers", async () => {
  const working = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  const sendAndFinish = operation({
    label: "test.send-and-finish",
    depends: { request: httpRequest.controller },
    run: async ({ request }, { signal }) => {
      const reply = await request.run({
        rawInput: { url: "https://example.test/x", method: "GET" },
      });
      working.resolve(signal);
      await finish.promise;
      return reply.body;
    },
  });
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: httpBackend(async () => new Response("finished")),
  });
  await scope.ready;
  const session = scope.createSession();
  const sending = session.run(sendAndFinish);
  const signal = await working.promise;
  let closed = false;
  const closing = session.close({ graceful: true }).then((end) => {
    closed = true;
    return end;
  });
  expect(signal.aborted).toBe(false);
  expect(closed).toBe(false);
  finish.resolve();
  expect(await sending).toBe("finished");
  expect(await closing).toEqual({ status: "success" });
  stop.abort();
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

test("releasing HTTP aborts a held direct send and leaves the scope open", async () => {
  const backend = createHeldBackend();
  const stop = new AbortController();
  const scope = createScope({ signal: stop.signal, tags: backend.binding });
  await scope.ready;
  const sending = expect(
    scope.resolve(http).send("https://example.test/held", {
      method: "GET",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError", code: 20 });
  await backend.started;
  scope.release(http);
  await sending;
  expect(scope.run(operation({ label: "test.after-release", run: () => "still open" }))).toBe(
    "still open",
  );
  stop.abort();
  expect(await scope.closed).toEqual({ status: "success" });
}, 2000);

test.each(["signal", "tags"] as const)(
  "a root-bound backendStop reaches a Core-made session (%s)",
  async (shape) => {
    const backend = createHeldBackend();
    const stop = new AbortController();
    const end = new AbortController();
    const call = new AbortController();
    const scope = createScope({
      signal: stop.signal,
      tags: [backend.binding, backendStop(end.signal)],
    });
    await scope.ready;
    const input = { url: "https://slow.test/x", method: "GET" };
    const sending =
      shape === "signal"
        ? scope.settle(httpRequest, { rawInput: input, signal: call.signal })
        : scope.settle(httpRequest, { rawInput: input, tags: requestStop(call.signal) });
    await backend.started;
    end.abort();
    const result = await sending;
    expect(result.status).toBe("failed");
    stop.abort();
    expect(await scope.closed).toEqual({ status: "success" });
  },
  2000,
);
