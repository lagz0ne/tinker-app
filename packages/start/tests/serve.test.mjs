import { expect, test } from "vite-plus/test";
import { asset } from "../lib/serve.mjs";
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
  const robots = await asset(root, new Request("http://app/robots.txt"));
  expect(robots?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(robots?.headers.get("cache-control")).toBe("public,max-age=0,must-revalidate");
  const about = await asset(root, new Request("http://app/about"));
  expect(await about?.text()).toBe("<p>About</p>");
  expect(about?.headers.get("content-type")).toBe("text/html; charset=utf-8");
});

test("a hashed asset is immutable, and a missing one is a 404", async () => {
  const root = built();
  expect(
    (await asset(root, new Request("http://app/assets/app-1a2b.js")))?.headers.get("cache-control"),
  ).toBe("public,max-age=31536000,immutable");
  expect((await asset(root, new Request("http://app/assets/gone.js")))?.status).toBe(404);
});

test("pages, dot paths, escapes, and writes pass on to the server entry", async () => {
  const root = built();
  expect(await asset(root, new Request("http://app/"))).toBeNull();
  expect(await asset(root, new Request("http://app/posts/1"))).toBeNull();
  expect(await asset(root, new Request("http://app/.vite/manifest.json"))).toBeNull();
  expect(await asset(root, new Request("http://app/..%2f..%2fetc/passwd"))).toBeNull();
  expect(await asset(root, new Request("http://app/robots.txt", { method: "POST" }))).toBeNull();
});
