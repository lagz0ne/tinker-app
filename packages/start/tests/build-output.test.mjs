import { existsSync, readFileSync } from "node:fs";
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
  expect(existsSync(join(root, "image.png.br"))).toBe(false);
  expect(existsSync(join(root, "image.png.gz"))).toBe(false);
});

test("server body chunks do not import each other before deps are set", async () => {
  const { output } = await build({
    configFile: false,
    resolve: {
      alias: {
        "~/components": new URL("../../../apps/start-scaffold/tinker/components", import.meta.url)
          .pathname,
      },
    },
    root: new URL("..", import.meta.url).pathname,
    logLevel: "silent",
    plugins: [serverOutput()],
    build: {
      ssr: new URL(
        "../../../apps/start-scaffold/tinker/components/requests/start.ts",
        import.meta.url,
      ).pathname,
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

test("both output plugins run only in a build", () => {
  expect(clientOutput()).toMatchObject({ name: "tinker:client-output", apply: "build" });
  expect(serverOutput()).toMatchObject({ name: "tinker:server-output", apply: "build" });
});

test("the compile hint skips assets, needs no source map, and is off when asked", () => {
  const bare = () => ({ type: "chunk", isEntry: true, fileName: "bare.js", code: "export {}" });
  const asset = { type: "asset", fileName: "logo.svg", source: "<svg/>" };
  const hinted = bare();

  clientOutput().generateBundle({}, { "bare.js": hinted, "logo.svg": asset });
  const plain = bare();
  clientOutput(false).generateBundle({}, { "bare.js": plain });

  expect(hinted.code).toBe("//# allFunctionsCalledOnLoad\nexport {}");
  expect(hinted.map).toBeUndefined();
  expect(asset).toEqual({ type: "asset", fileName: "logo.svg", source: "<svg/>" });
  expect(plain.code).toBe("export {}");
});

test("an app's telemetry worker is emitted beside the server, in the SSR build only", () => {
  const root = fixture({ "cmds/telemetry-worker.ts": "export default 1;" });
  const emit = (plugin, environment) => {
    const emitted = [];
    plugin.buildStart.call({ environment, emitFile: (file) => emitted.push(file) });
    return emitted;
  };

  expect(emit(serverOutput(root), { name: "ssr" })).toEqual([
    { type: "chunk", id: join(root, "cmds/telemetry-worker.ts"), fileName: "telemetry-worker.js" },
  ]);
  expect(emit(serverOutput(root), { name: "client" })).toEqual([]);
  expect(emit(serverOutput(root), undefined)).toEqual([]);
  expect(emit(serverOutput(fixture({})), { name: "ssr" })).toEqual([]);
  expect(emit(serverOutput(), { name: "ssr" })).toEqual([]);
});

test("only the SSR build keeps Core external and groups the request body", () => {
  const plugin = serverOutput();

  const ssr = plugin.configEnvironment("ssr");

  expect(plugin.configEnvironment("client")).toBeUndefined();
  expect(ssr.resolve).toEqual({ external: ["@tinker/core"] });
  const [group] = ssr.build.rolldownOptions.output.codeSplitting.groups;
  expect(group.name).toBe("tinker-start");
  expect(group.test("/app/tinker/components/requests/body.server.ts")).toBe(true);
  expect(group.test("/app/tinker/components/requests/body.ts")).toBe(false);
});
