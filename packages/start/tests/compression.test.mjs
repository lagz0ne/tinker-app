import { brotliDecompressSync, gunzipSync } from "node:zlib";
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
