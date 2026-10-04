import { expect, test } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { httpBackend, httpRequest, isError, raise } from "@tinker-start-scaffold/backend";
import { http } from "@tinker-start-scaffold/transport";

const post = operation({
  label: "test.post",
  depends: { request: httpRequest.controller },
  run: ({ request }) =>
    request.run({ input: { url: "https://example.test/x?secret=1", method: "POST" } }),
});

test("an HTTP request makes one named child span with its status", async () => {
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    observe: { history: 20 },
    tags: [httpBackend(async () => new Response("not found", { status: 404 }))],
  });
  await scope.ready;
  try {
    expect((await scope.run(post)).status).toBe(404);
    const spans = scope.spans();
    const caller = spans.find((span) => span.name === "test.post");
    const request = spans.find((span) => span.name === "http.request");
    expect(request?.parentId).toBe(caller?.id);
    expect(
      spans
        .filter((span) => span.name === "http POST /x")
        .map((span) => ({
          parentId: span.parentId,
          status: span.status,
          attributes: span.attributes,
        })),
    ).toEqual([
      {
        parentId: request?.id,
        status: "ok",
        attributes: {
          "http.request.method": "POST",
          "url.path": "/x",
          "http.response.status_code": 404,
        },
      },
    ]);
    expect(spans.some((span) => span.name === "http" && span.kind === "resource")).toBe(true);
  } finally {
    stop.abort();
    expect((await scope.closed).status).toBe("success");
  }
});

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
            if (!signal) raise("BadInput", { reason: "request must have a signal" });
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
        input: {
          url: "https://no-network.invalid/x",
          method: "POST",
          headers: { "x-request": "yes" },
          body: "hello",
        },
      }),
    ).toEqual({
      status: 201,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-reply": "yes" },
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

test("a network failure keeps only method and path in the managed HTTP error", async () => {
  const cause = new TypeError("connection refused: https://example.test/x?token=hidden");
  const stop = new AbortController();
  const scope = createScope({
    signal: stop.signal,
    tags: [
      httpBackend(async () => {
        throw cause;
      }),
    ],
  });
  await scope.ready;
  try {
    const result = await scope.settle(httpRequest, {
      input: { url: "https://example.test/x?token=hidden", method: "GET" },
    });
    if (result.status !== "failed") raise("BadInput", { reason: "request must fail" });
    if (!isError(result.error, "HttpRequestFailed")) throw result.error;
    expect(result.error.payload).toEqual({ method: "GET", path: "/x" });
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
        if (!signal) raise("BadInput", { reason: "request must have a signal" });
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
