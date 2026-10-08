import { expect, test } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { httpRequest } from "@tinker/start/server";
import { httpBackend } from "@tinker/start/testing";

const post = operation({
  label: "test.post",
  depends: { request: httpRequest.controller },
  run: ({ request }) =>
    request.run({ rawInput: { url: "https://example.test/x?secret=1", method: "POST" } }),
});

test("an HTTP request makes two spans and records its status", async () => {
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
