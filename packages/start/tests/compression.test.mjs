import { brotliDecompressSync, gunzipSync, createBrotliDecompress, createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { expect, test } from "vite-plus/test";
import { compressResponse, readEncoding } from "../lib/compression.mjs";

/** A streamed HTML body with a length that must be removed after compression. */
const html = () =>
  new Response("<p>Hello</p>", {
    headers: { "content-type": "text/html", "content-length": "12", vary: "Cookie" },
  });

test("encoding weights, exclusions, wildcard, and identity are honored", () => {
  const choices = [
    ["", "identity"],
    ["gzip, br", "br"],
    ["br;q=0.1,gzip;q=1", "gzip"],
    ["br;q=0,*;q=1", "gzip"],
    ["gzip;q=0,br;q=0", "identity"],
    ["*;q=0", null],
    ["identity;q=1,br;q=0.5", "identity"],
    ["BR; Q=1", "br"],
    ["gzip;q=bad", "identity"],
  ];
  for (const [accepted, chosen] of choices)
    expect(
      readEncoding(new Request("http://app", { headers: { "accept-encoding": accepted } })),
    ).toBe(chosen);
});

test("streamed HTML is compressed and keeps existing Vary fields", async () => {
  for (const encoding of ["gzip", "br"]) {
    const response = await compressResponse(
      new Request("http://app", { headers: { "accept-encoding": encoding } }),
      html(),
    );
    expect(response.headers.get("content-encoding")).toBe(encoding);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect((encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString()).toBe(
      "<p>Hello</p>",
    );
  }
});

test("plain HTML still varies by encoding and refused encodings get 406", async () => {
  const response = await compressResponse(new Request("http://app"), html());
  expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  expect(await response.text()).toBe("<p>Hello</p>");
  expect(
    (
      await compressResponse(
        new Request("http://app", { headers: { "accept-encoding": "*;q=0" } }),
        html(),
      )
    ).status,
  ).toBe(406);
});

test("encoded, partial, no-transform, and non-text responses pass through", async () => {
  for (const response of [
    new Response("png", { headers: { "content-type": "image/png" } }),
    new Response("x", { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
    new Response("x", { status: 206, headers: { "content-type": "text/html" } }),
    new Response("x", {
      headers: { "content-type": "text/html", "cache-control": "no-transform" },
    }),
  ])
    expect(await compressResponse(new Request("http://app"), response)).toBe(response);
});

test("a refused encoding cancels HTML and drops its old length", async () => {
  let cancelled = false;
  const response = await compressResponse(
    new Request("http://app", { headers: { "accept-encoding": "*;q=0" } }),
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: { "content-type": "text/html", "content-length": "12" },
      },
    ),
  );
  expect(cancelled).toBe(true);
  expect(response.headers.get("content-length")).toBeNull();
});

test("HEAD cancels HTML and returns its negotiated encoding without a body", async () => {
  let cancelled = false;
  const response = await compressResponse(
    new Request("http://app", { method: "HEAD", headers: { "accept-encoding": "br" } }),
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: { "content-type": "text/html", "content-length": "12" },
      },
    ),
  );
  expect(cancelled).toBe(true);
  expect(response.body).toBeNull();
  expect(response.headers.get("content-encoding")).toBe("br");
  expect(response.headers.get("content-length")).toBeNull();
  const empty = await compressResponse(
    new Request("http://app", { method: "HEAD", headers: { "accept-encoding": "br" } }),
    new Response(null, { headers: { "content-type": "text/html" } }),
  );
  expect(empty.headers.get("content-encoding")).toBe("br");
});

test.each(["gzip", "br"])("%s sends the HTML shell before the source ends", async (encoding) => {
  const shell = "<!DOCTYPE html><body>" + "x".repeat(4000);
  const tail = "</body>";
  let source;
  const body = new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode(shell));
    },
  });
  const response = await compressResponse(
    new Request("http://app", { headers: { "accept-encoding": encoding } }),
    new Response(body, { headers: { "content-type": "text/html" } }),
  );
  const encoded = Readable.fromWeb(response.body);
  const decoded = encoded.pipe(encoding === "br" ? createBrotliDecompress() : createGunzip());
  const chunks = decoded[Symbol.asyncIterator]();
  try {
    const first = await chunks.next();
    expect(first.value.toString()).toBe(shell);
    source.enqueue(new TextEncoder().encode(tail));
    source.close();
    let rest = "";
    for await (const chunk of chunks) rest += chunk.toString();
    expect(rest).toBe(tail);
  } finally {
    encoded.destroy();
    decoded.destroy();
  }
});

test("a source failure reaches the compressed response reader", async () => {
  const failure = new Error("source failed");
  const response = await compressResponse(
    new Request("http://app", { headers: { "accept-encoding": "br" } }),
    new Response(new ReadableStream({ start: (source) => source.error(failure) }), {
      headers: { "content-type": "text/html" },
    }),
  );
  await expect(response.arrayBuffer()).rejects.toBe(failure);
});

test("cancelling compressed HTML cancels the unfinished source", async () => {
  const cancelled = Promise.withResolvers();
  const response = await compressResponse(
    new Request("http://app", { headers: { "accept-encoding": "br" } }),
    new Response(new ReadableStream({ cancel: () => cancelled.resolve(true) }), {
      headers: { "content-type": "text/html" },
    }),
  );
  await response.body.cancel();
  expect(await cancelled.promise).toBe(true);
});
