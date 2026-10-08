import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { expect, test } from "vite-plus/test";
import { createAssets } from "../lib/serve.mjs";
import { fixture } from "./fixture.mjs";

/** A built app's client folder: a hashed asset, a public/ file, and a prerendered page. */
const built = () =>
  fixture({
    "dist/client/assets/app-1a2b.js": "console.log(1)",
    "dist/client/robots.txt": "User-agent: *\n",
    "dist/client/about/index.html": "<p>About</p>",
    "dist/client/.vite/manifest.json": "{}",
  });

test("a public/ file and a prerendered page are served, with revalidation", async () => {
  const root = built();
  const asset = await createAssets(root);
  const robots = await asset(new Request("http://app/robots.txt"));
  expect(robots?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(robots?.headers.get("cache-control")).toBe("public,max-age=0,must-revalidate");
  const about = await asset(new Request("http://app/about"));
  expect(await about?.text()).toBe("<p>About</p>");
  expect(about?.headers.get("content-type")).toBe("text/html; charset=utf-8");
});

test("a hashed asset is immutable, and a missing one is a 404", async () => {
  const root = built();
  const asset = await createAssets(root);
  expect(
    (await asset(new Request("http://app/assets/app-1a2b.js")))?.headers.get("cache-control"),
  ).toBe("public,max-age=31536000,immutable");
  expect((await asset(new Request("http://app/assets/gone.js")))?.status).toBe(404);
});

test("pages, dot paths, escapes, and writes pass on to the server entry", async () => {
  const root = built();
  const asset = await createAssets(root);
  expect(await asset(new Request("http://app/"))).toBeNull();
  expect(await asset(new Request("http://app/posts/1"))).toBeNull();
  expect(await asset(new Request("http://app/.vite/manifest.json"))).toBeNull();
  expect(await asset(new Request("http://app/..%2f..%2fetc/passwd"))).toBeNull();
  expect(await asset(new Request("http://app/robots.txt", { method: "POST" }))).toBeNull();
});

test("each built file type is served with its content type", async () => {
  const types = {
    "a.js": "text/javascript",
    "a.css": "text/css",
    "a.svg": "image/svg+xml",
    "a.png": "image/png",
    "a.json": "application/json",
    "a.ico": "image/x-icon",
    "a.xml": "application/xml",
    "a.webmanifest": "application/manifest+json",
    "a.wasm": "application/octet-stream",
  };
  const root = fixture(
    Object.fromEntries(Object.keys(types).map((file) => [`dist/client/assets/${file}`, "x"])),
  );
  const asset = await createAssets(root);
  const served = await Promise.all(
    Object.keys(types).map((file) =>
      Promise.resolve(asset(new Request(`http://app/assets/${file}`))),
    ),
  );
  expect(served.map((response) => response?.headers.get("content-type"))).toEqual(
    Object.values(types),
  );
});

test("a HEAD request gets the file; a path under a file passes on", async () => {
  const root = built();
  const asset = await createAssets(root);
  const head = await asset(new Request("http://app/robots.txt", { method: "HEAD" }));
  expect(head?.status).toBe(200);
  expect(await asset(new Request("http://app/robots.txt/more"))).toBeNull();
});

test("a built file that cannot be read fails the request, not a silent 404", async () => {
  const root = built();
  symlinkSync("loop.txt", join(root, "dist/client/loop.txt"));
  const asset = await createAssets(root);
  await expect(asset(new Request("http://app/loop.txt"))).rejects.toMatchObject({
    code: "ELOOP",
  });
});

test("a host keeps its file list until restart", async () => {
  const root = built();
  const asset = await createAssets(root);
  writeFileSync(join(root, "dist/client/new.html"), "<p>New</p>");
  expect(await asset(new Request("http://app/new.html"))).toBeNull();
  const restarted = await createAssets(root);
  expect(await (await restarted(new Request("http://app/new.html")))?.text()).toBe("<p>New</p>");
});

test("unhashed assets need revalidation and HEAD has no body", async () => {
  const root = fixture({ "dist/client/assets/app.js": "export {}" });
  const asset = await createAssets(root);
  const response = await asset(new Request("http://app/assets/app.js", { method: "HEAD" }));
  expect(response.headers.get("cache-control")).toBe("public,max-age=0,must-revalidate");
  expect(response.body).toBeNull();
});

test("JS, CSS, and HTML compress on demand with Vary", async () => {
  const root = fixture({
    "dist/client/assets/app-1234.js": "export {}",
    "dist/client/style.css": "body{color:red}",
    "dist/client/index.html": "<p>Hello</p>",
  });
  const asset = await createAssets(root);
  for (const [path, text] of [
    ["assets/app-1234.js", "export {}"],
    ["style.css", "body{color:red}"],
    ["", "<p>Hello</p>"],
  ]) {
    for (const encoding of ["br", "gzip"]) {
      const response = await asset(
        new Request(`http://app/${path}`, { headers: { "accept-encoding": encoding } }),
      );
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      const bytes = Buffer.from(await response.arrayBuffer());
      expect((encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString()).toBe(
        text,
      );
    }
  }
});

test("the host uses a build's compressed copy", async () => {
  const root = built();
  const file = join(root, "dist/client/assets/app-1a2b.js");
  writeFileSync(`${file}.br`, brotliCompressSync("built copy"));
  const asset = await createAssets(root);
  unlinkSync(file);
  const response = await asset(
    new Request("http://app/assets/app-1a2b.js", { headers: { "accept-encoding": "br" } }),
  );
  expect(brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(
    "built copy",
  );
});

test("a public gzip download keeps its bytes and is not a response encoding", async () => {
  const root = fixture({ "dist/client/archive.txt.gz": "" });
  writeFileSync(join(root, "dist/client/archive.txt.gz"), gzipSync("archive bytes"));
  const asset = await createAssets(root);
  const response = await asset(
    new Request("http://app/archive.txt.gz", { headers: { "accept-encoding": "br" } }),
  );
  expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe("archive bytes");
  expect(response?.headers.get("content-type")).toBe("application/octet-stream");
  expect(response?.headers.get("content-encoding")).toBeNull();
});

test("a warmed host serves its retained raw and encoded bytes after files go away", async () => {
  const root = built();
  const asset = await createAssets(root);
  const raw = new Request("http://app/robots.txt");
  const zipped = new Request("http://app/assets/app-1a2b.js", {
    headers: { "accept-encoding": "br" },
  });
  await (await asset(raw)).text();
  await (await asset(zipped)).arrayBuffer();
  unlinkSync(join(root, "dist/client/robots.txt"));
  unlinkSync(join(root, "dist/client/assets/app-1a2b.js"));
  const text = asset(raw);
  const bytes = asset(zipped);
  expect(text).toBeInstanceOf(Response);
  expect(bytes).toBeInstanceOf(Response);
  expect(await text.text()).toBe("User-agent: *\n");
  expect(brotliDecompressSync(Buffer.from(await bytes.arrayBuffer())).toString()).toBe(
    "console.log(1)",
  );
});
