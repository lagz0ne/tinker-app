import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite-plus";
import { expect, test } from "vite-plus/test";
import { clientOutput, serverOutput } from "../lib/build-output.mjs";
import { fixture } from "./fixture.mjs";

test("only client entry chunks get Chrome's compile hint, on by default", () => {
  const plugin = clientOutput();
  expect(plugin.applyToEnvironment({ name: "client" })).toBe(true);
  expect(plugin.applyToEnvironment({ name: "ssr" })).toBe(false);
  expect(plugin.augmentChunkHash({ isEntry: true })).toBe("//# allFunctionsCalledOnLoad");
  expect(plugin.augmentChunkHash({ isEntry: false })).toBe("");
  expect(clientOutput(false).augmentChunkHash({ isEntry: true })).toBe("");
  const entry = {
    type: "chunk",
    isEntry: true,
    fileName: "app.js",
    code: "export {}",
    map: { mappings: "AAAA" },
  };
  const lazy = { type: "chunk", isEntry: false, code: "export {}" };
  const map = { type: "asset", source: '{"mappings":"AAAA"}' };
  plugin.generateBundle({}, { "app.js": entry, "lazy.js": lazy, "app.js.map": map });
  expect(entry.code).toBe("//# allFunctionsCalledOnLoad\nexport {}");
  expect(entry.map.mappings).toBe(";AAAA");
  expect(JSON.parse(map.source).mappings).toBe(";AAAA");
  expect(lazy.code).toBe("export {}");
});

test("the build writes Brotli and gzip copies of JS, CSS, and HTML", async () => {
  const root = fixture({
    "assets/app.js": "export {}",
    "style.css": "body{}",
    "index.html": "<p>Hi</p>",
    "image.png": "png",
  });
  await clientOutput().writeBundle({ dir: root });
  for (const [file, text] of [
    ["assets/app.js", "export {}"],
    ["style.css", "body{}"],
    ["index.html", "<p>Hi</p>"],
  ]) {
    expect(brotliDecompressSync(readFileSync(join(root, `${file}.br`))).toString()).toBe(text);
    expect(gunzipSync(readFileSync(join(root, `${file}.gz`))).toString()).toBe(text);
  }
});

test("server body chunks do not import each other before deps are set", async () => {
  const { output } = await build({
    configFile: false,
    root: new URL("..", import.meta.url).pathname,
    logLevel: "silent",
    plugins: [serverOutput()],
    build: {
      ssr: "src/start.ts",
      write: false,
      minify: false,
      rolldownOptions: { external: /^(?:@tanstack\/|drizzle-orm$)/ },
    },
  });
  const chunks = output.filter((file) => file.type === "chunk");
  expect(chunks.length).toBeGreaterThan(1);
  const cycles = chunks.flatMap((chunk) =>
    chunks
      .filter(
        (other) => chunk.imports.includes(other.fileName) && other.imports.includes(chunk.fileName),
      )
      .map((other) => [chunk.fileName, other.fileName]),
  );
  expect(cycles).toEqual([]);
});
