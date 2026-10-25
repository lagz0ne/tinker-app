import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  createBrotliDecompress,
  createGunzip,
  gunzipSync,
} from "node:zlib";

import { expect, test } from "vite-plus/test";

import {
  compressBytes,
  compressResponse,
  isCompressible,
  readEncoding,
} from "../lib/compression.mjs";

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
  for (const [accepted, chosen] of choices) {
    expect(
      readEncoding(new Request("http://app", { headers: { "accept-encoding": accepted } })),
    ).toBe(chosen);
  }
});

test("finished short HTML is compressed whole with its new length and existing Vary fields", async () => {
  for (const encoding of ["gzip", "br"]) {
    const response = await compressResponse(
      new Request("http://app", { headers: { "accept-encoding": encoding } }),
      html(),
    );
    expect(response.headers.get("content-encoding")).toBe(encoding);
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect((encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString()).toBe(
      "<p>Hello</p>",
    );
  }
});

test.each(["gzip", "br"])("%s joins the ready chunks of a finished body", async (encoding) => {
  const parts = ["<!DOCTYPE html>", "<body>", "</body>"];
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  const response = await compressResponse(
    new Request("http://app", { headers: { "accept-encoding": encoding } }),
    new Response(body, { headers: { "content-type": "text/html" } }),
  );

  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  expect((encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString()).toBe(
    parts.join(""),
  );
});

test("a finished body over 64 KiB keeps the stream without a length", async () => {
  const page = "<p>" + "x".repeat(70000) + "</p>";
  const response = await compressResponse(
    new Request("http://app", { headers: { "accept-encoding": "br" } }),
    new Response(page, { headers: { "content-type": "text/html" } }),
  );

  expect(response.headers.get("content-length")).toBeNull();
  expect(brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(page);
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

test("plain HTML keeps the app's response, and a fetched one is copied to vary", async () => {
  const app = html();
  const fetched = await fetch("data:text/html,<p>Fetched</p>");

  const kept = await compressResponse(new Request("http://app"), app);
  const copied = await compressResponse(new Request("http://app"), fetched);

  expect(kept).toBe(app);
  expect(kept.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  expect(copied).not.toBe(fetched);
  expect(copied.headers.get("vary")).toBe("Accept-Encoding");
  expect(await copied.text()).toBe("<p>Fetched</p>");
});

test("encoded, partial, no-transform, and non-text responses pass through", async () => {
  for (const response of [
    new Response("png", { headers: { "content-type": "image/png" } }),
    new Response("x", { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
    new Response("x", { status: 206, headers: { "content-type": "text/html" } }),
    new Response("x", {
      headers: { "content-type": "text/html", "cache-control": "no-transform" },
    }),
  ]) {
    expect(await compressResponse(new Request("http://app"), response)).toBe(response);
  }
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

test("a plain HEAD still drops the HTML body and cancels its source", async () => {
  let cancelled = false;
  const source = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });

  const response = await compressResponse(
    new Request("http://app", { method: "HEAD" }),
    new Response(source, { headers: { "content-type": "text/html" } }),
  );

  expect(cancelled).toBe(true);
  expect(response.body).toBeNull();
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
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

/** @param {string} accepted - From a test; why: the Accept-Encoding header to negotiate. */
const offered = (accepted) =>
  new Request("http://app", { headers: { "accept-encoding": accepted } });

test("weights out of range, a spaced q, and other parameters are read as the header says", () => {
  // readEncoding keeps each header's choice; a fresh unknown token makes this run read it again.
  const fresh = `, x-fresh-${crypto.randomUUID()}`;
  const choices = [
    ["br;q=2, gzip;q=0.5", "gzip"],
    ["br;q=1.5, gzip;q=0.5", "gzip"],
    ["gzip;q=1, br; q=0.5", "gzip"],
    ["br;level=1, gzip;q=0.5", "br"],
    ["identity;q=0, br;q=0, gzip;q=0", null],
  ];

  for (const [accepted, chosen] of choices) {
    expect([accepted, readEncoding(offered(accepted + fresh))]).toEqual([accepted, chosen]);
  }
});

test("only JS, CSS, and HTML types are compressible", () => {
  const types = {
    "text/html; charset=utf-8": true,
    "TEXT/CSS": true,
    "text/javascript": true,
    "application/javascript": true,
    "text/htmlx": false,
    "application/x-text/html": false,
    "image/svg+xml": false,
    "": false,
  };

  for (const [type, compressible] of Object.entries(types)) {
    expect([type, isCompressible(type)]).toEqual([type, compressible]);
  }
});

test("encoded, partial, no-transform, untyped, and non-text responses pass through even with br", async () => {
  for (const response of [
    new Response("png", { headers: { "content-type": "image/png" } }),
    new Response("x"),
    new Response("x", { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
    new Response("x", { status: 206, headers: { "content-type": "text/html" } }),
    new Response("x", {
      headers: { "content-type": "text/html", "cache-control": "public, No-Transform" },
    }),
  ]) {
    const passed = await compressResponse(offered("br"), response);

    expect(passed).toBe(response);
    expect(passed.headers.get("vary")).toBeNull();
  }
});

test("a cache-control without no-transform still compresses", async () => {
  const response = await compressResponse(
    offered("br"),
    new Response("<p>x</p>", {
      headers: { "content-type": "text/html", "cache-control": "public" },
    }),
  );

  expect(response.headers.get("content-encoding")).toBe("br");
});

test.each([
  ["*", "*"],
  ["Accept-Encoding, Cookie", "Accept-Encoding, Cookie"],
  ["Cookie,Accept-Encoding", "Cookie,Accept-Encoding"],
  ["Cookie , ACCEPT-ENCODING", "Cookie , ACCEPT-ENCODING"],
  ["Cookie", "Cookie, Accept-Encoding"],
])("a Vary of %j becomes %j", async (vary, expected) => {
  const response = await compressResponse(
    offered("gzip"),
    new Response("<p>x</p>", { headers: { "content-type": "text/html", vary } }),
  );

  expect(response.headers.get("vary")).toBe(expected);
});

test("HTML with no body gets no encoding, and a refused encoding still answers 406", async () => {
  const empty = () => new Response(null, { headers: { "content-type": "text/html" } });

  const encoded = await compressResponse(offered("br"), empty());
  const refused = await compressResponse(offered("*;q=0"), empty());

  expect(encoded.body).toBeNull();
  expect(encoded.headers.get("content-encoding")).toBeNull();
  expect(encoded.headers.get("vary")).toBe("Accept-Encoding");
  expect(refused.status).toBe(406);
});

test("a plain HEAD gets no content encoding", async () => {
  const response = await compressResponse(
    new Request("http://app", { method: "HEAD" }),
    new Response("<p>x</p>", { headers: { "content-type": "text/html" } }),
  );

  expect(response.headers.get("content-encoding")).toBeNull();
});

test("a finished body of exactly 64 KiB is still compressed whole with its length", async () => {
  const page = "<p>" + "x".repeat(65536 - 7) + "</p>";
  const response = await compressResponse(
    offered("gzip"),
    new Response(new TextEncoder().encode(page), { headers: { "content-type": "text/html" } }),
  );

  const bytes = Buffer.from(await response.arrayBuffer());

  expect(Buffer.byteLength(page)).toBe(65536);
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  expect(gunzipSync(bytes).toString()).toBe(page);
});

test("serving encodes Brotli at the fast level 4; the build asks for its own level", async () => {
  const text = readFileSync(new URL("../lib/compression.mjs", import.meta.url), "utf8");
  const level = (quality, extra = {}) =>
    brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, ...extra } });
  expect(level(4).equals(level(11))).toBe(false);

  const served = await compressResponse(
    offered("br"),
    new Response(text, { headers: { "content-type": "text/javascript" } }),
  );
  const hint = { [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text) };

  expect(Buffer.from(await served.arrayBuffer()).equals(level(4, hint))).toBe(true);
  expect((await compressBytes(text, "br")).equals(level(4))).toBe(true);
  expect((await compressBytes(text, "br", 11)).equals(level(11))).toBe(true);
});
