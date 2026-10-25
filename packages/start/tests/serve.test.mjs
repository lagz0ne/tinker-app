import { rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("an escaped name, a query, and doubled slashes find the same built file", async () => {
  const root = fixture({ "dist/client/a b.txt": "spaced", "dist/client/robots.txt": "robots" });
  const asset = await createAssets(root);

  const served = await Promise.all(
    [
      "http://app/a%20b.txt",
      "http://app/a b.txt?x=1",
      "https://app:8443//a%20b.txt",
      "http://app/robots.txt?a/b#c",
      "https://app///robots.txt",
      "http://app/a%20b.txt#top",
      "http://app/robots.txt#a?b",
    ].map(async (url) => (await asset(new Request(url)))?.text()),
  );

  expect(served).toEqual(["spaced", "spaced", "spaced", "robots", "robots", "spaced", "robots"]);
  expect(() => asset(new Request("http://app/%E0%A4%A"))).toThrow(URIError);
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

test("an app with no client build serves nothing, and a client path that is a file fails", async () => {
  const root = fixture({ "dist/server/server.js": "" });
  const asset = await createAssets(root);
  writeFileSync(join(root, "dist/client"), "not a folder");

  expect(await asset(new Request("http://app/robots.txt"))).toBeNull();
  await expect(createAssets(root)).rejects.toMatchObject({ code: "ENOTDIR" });
});

test("a URL with another scheme still finds its built file by its pathname", async () => {
  const asset = await createAssets(built());

  const response = await asset(new Request("app://h/robots.txt"));

  expect(await response?.text()).toBe("User-agent: *\n");
});

test("only compressible files vary and carry their length; a refused encoding is a 406", async () => {
  const root = fixture({ "dist/client/a.png": "png", "dist/client/assets/app.js": "export {}" });
  const asset = await createAssets(root);
  const refused = { headers: { "accept-encoding": "*;q=0" } };

  const png = await asset(new Request("http://app/a.png", refused));
  const js = await asset(new Request("http://app/assets/app.js"));
  const blocked = await asset(new Request("http://app/assets/app.js", refused));

  expect(png.status).toBe(200);
  expect(png.headers.get("vary")).toBeNull();
  expect(png.headers.get("content-length")).toBeNull();
  expect(js.headers.get("content-length")).toBe("9");
  expect(blocked.status).toBe(406);
  expect(blocked.body).toBeNull();
  expect(blocked.headers.get("vary")).toBe("Accept-Encoding");
  expect(blocked.headers.get("content-type")).toBe("text/javascript");
});

test("the host uses a build's gzip copy", async () => {
  const root = built();
  const file = join(root, "dist/client/assets/app-1a2b.js");
  writeFileSync(`${file}.gz`, gzipSync("built gzip copy"));
  const asset = await createAssets(root);

  const response = await asset(
    new Request("http://app/assets/app-1a2b.js", { headers: { "accept-encoding": "gzip" } }),
  );

  expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe("built gzip copy");
});

test("only a hashed name in assets/ is immutable", async () => {
  const root = fixture({
    "dist/client/robots-1a2b3c.txt": "x",
    "dist/client/assets/app-1a2b.v/plain": "x",
  });
  const asset = await createAssets(root);

  for (const path of ["/robots-1a2b3c.txt", "/assets/app-1a2b.v/plain"]) {
    const response = await asset(new Request(`http://app${path}`));
    expect([path, response.headers.get("cache-control")]).toEqual([
      path,
      "public,max-age=0,must-revalidate",
    ]);
  }
});

test("a failed read is not kept: the next request reads the file again", async () => {
  const root = built();
  const loop = join(root, "dist/client/loop.txt");
  symlinkSync("loop.txt", loop);
  const asset = await createAssets(root);
  await expect(asset(new Request("http://app/loop.txt"))).rejects.toMatchObject({ code: "ELOOP" });

  unlinkSync(loop);
  writeFileSync(loop, "fixed");

  expect(await (await asset(new Request("http://app/loop.txt"))).text()).toBe("fixed");
});

test("the host keeps up to 64 MiB of built bytes, and reads the rest each time", async () => {
  const root = fixture({ "dist/client/small.txt": "s" });
  writeFileSync(join(root, "dist/client/big.txt"), Buffer.alloc(64 * 1024 * 1024));
  const asset = await createAssets(root);
  const big = new Request("http://app/big.txt");
  const small = new Request("http://app/small.txt");

  expect((await (await asset(big)).arrayBuffer()).byteLength).toBe(64 * 1024 * 1024);
  expect(await (await asset(small)).text()).toBe("s");
  rmSync(join(root, "dist/client/big.txt"));
  rmSync(join(root, "dist/client/small.txt"));

  expect((await (await asset(big)).arrayBuffer()).byteLength).toBe(64 * 1024 * 1024);
  await expect(asset(small)).rejects.toMatchObject({ code: "ENOENT" });
});
