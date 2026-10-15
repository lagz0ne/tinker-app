import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { expect, test } from "vite-plus/test";

import { aliases, passThrough, startOptions } from "../lib/glue.mjs";
import { appFiles, ignoredFiles } from "../lib/named.mjs";
import { baseDir } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

test("the glue picks up the app entry and the three optional named files", () => {
  expect(appFiles(fixture({})).map(({ file }) => file)).toEqual([
    "cmds/router.ts",
    "cmds/start.ts",
    expect.stringContaining("cmds/server.ts"),
  ]);
});

test("aliases keep app paths and the route tree, without runtime seams", () => {
  const root = fixture({});
  const table = aliases(root);
  const rewrite = (name) => {
    const alias = table.find(({ find }) => find.test(name));
    return alias ? name.replace(alias.find, alias.replacement) : name;
  };
  expect(["@/style.css?url", "~/components/errors", "#tinker/routes"].map(rewrite)).toEqual([
    `${root}/src/style.css?url`,
    `${root}/tinker/components/errors`,
    `${root}/.tinker/routeTree.gen.ts`,
  ]);
  for (const name of [
    "#tinker/server",
    "#tinker/router",
    "#tinker/start",
    "#tinker/parts",
    "#tinker/parts.server",
  ]) {
    expect(rewrite(name)).toBe(name);
  }
});

test("an alias matches its whole name only", () => {
  const table = aliases(fixture({}));
  const near = [
    "x@/backend/greet.ts",
    "x#tinker/routes",
    "#tinker/routes.ts",
    "x#tinker/parts",
    "#tinker/parts.ts",
    "x#tinker/parts.server",
    "#tinker/parts.server.ts",
  ];
  expect(near.filter((name) => table.some(({ find }) => find.test(name)))).toEqual([]);
});

test("Start's usual files the glue does not read are listed, and the read ones are not", () => {
  const files = ignoredFiles.map(({ file }) => file);
  expect(files).toContain("src/router.tsx");
  expect(files).toContain("src/client.tsx");
  expect(files).toContain("src/routeTree.gen.ts");

  expect(files).not.toContain("cmds/router.ts");
  expect(files).not.toContain("src/start.ts");
  expect(files).not.toContain("cmds/server.ts");
});

test("Start runs the app commands and discovers copied telemetry through the physical tree", () => {
  const file = readFileSync(
    join(baseDir, "../../apps/start-scaffold/src/routes/api.telemetry.ts"),
    "utf8",
  );
  const root = fixture({ "src/routes/index.tsx": "", "src/routes/api.telemetry.ts": file });
  const options = startOptions(root, []);

  expect(resolve(root, "src", options.server.entry)).toBe(join(root, "cmds/server.ts"));
  expect(resolve(root, "src", options.router.entry)).toBe(join(root, "cmds/router.ts"));
  expect(options.router.virtualRouteConfig.children).toEqual([
    { type: "physical", directory: ".", pathPrefix: "" },
  ]);
  expect(readFileSync(join(root, "src/routes/api.telemetry.ts"), "utf8")).toBe(file);
});

test("a part that is off mounts no route, so its path is the app's", () => {
  const root = fixture({ "src/routes/index.tsx": "" });
  const { virtualRouteConfig: tree } = startOptions(root, []).router;

  expect(tree.children.map((child) => child.path ?? child.pathPrefix)).toEqual([""]);
});

test("Start runs the base's entries, the generated route tree, and the base's import rules", () => {
  const root = fixture({ "src/routes/index.tsx": "" });
  const fromSrc = (file) => relative(join(root, "src"), join(root, file));
  const { virtualRouteConfig, ...router } = startOptions(root, []).router;
  expect({ ...startOptions(root, []), router }).toEqual({
    srcDirectory: "src",
    start: { entry: fromSrc("cmds/start.ts") },
    server: { entry: fromSrc("cmds/server.ts") },
    router: {
      entry: fromSrc("cmds/router.ts"),
      generatedRouteTree: "../.tinker/routeTree.gen.ts",
    },
    importProtection: {
      behavior: "error",
      client: {
        files: [/\.server\./, /\/backend\//],
        specifiers: ["@tanstack/react-start/server"],
      },
      server: { files: [/\.client\./] },
    },
  });
  expect(virtualRouteConfig.type).toBe("root");
});

test("the app's src/routes/__root.tsx replaces the base shell", () => {
  const root = fixture({ "src/routes/__root.tsx": "" });
  expect(startOptions(root, []).router.virtualRouteConfig.file).toBe("__root.tsx");
});

test("Start's static output options pass on; an unknown option fails the build", () => {
  expect(
    passThrough({ root: "/app", compileHints: false, prerender: { enabled: true } }),
  ).toStrictEqual({
    prerender: { enabled: true },
  });
  expect(() => passThrough({ prerendr: {}, sap: {} })).toThrow(
    "tinker(): unknown option prerendr, sap; known: root, serverEntry, compileHints, prerender, pages, spa, sitemap",
  );
  expect(passThrough({ spa: { enabled: true } })).toStrictEqual({
    spa: { enabled: true },
  });
});

test("auth's copied route stays in the physical app tree with either old switch value", () => {
  const file = readFileSync(
    join(baseDir, "../../apps/start-scaffold/src/routes/api.auth.$.ts"),
    "utf8",
  );
  const root = fixture({ "src/routes/index.tsx": "", "src/routes/api.auth.$.ts": file });
  for (const on of [["auth"], []]) {
    const { virtualRouteConfig: tree } = startOptions(root, on).router;
    expect(tree.children.map((child) => child.path ?? child.pathPrefix)).toEqual([""]);
    expect(tree.children.at(-1)).toEqual({ type: "physical", directory: ".", pathPrefix: "" });
    expect(readFileSync(join(root, "src/routes/api.auth.$.ts"), "utf8")).toBe(file);
  }
});

test("copied sync mounts physically from the app and has no plugin switch", () => {
  const file = 'export const Route = createFileRoute("/api/sync")({});\n';
  const root = fixture({ "src/routes/index.tsx": "", "src/routes/api.sync.ts": file });
  const { virtualRouteConfig: tree } = startOptions(root, []).router;

  expect(tree.children).toEqual([{ type: "physical", directory: ".", pathPrefix: "" }]);
  expect(readFileSync(join(root, "src/routes/api.sync.ts"), "utf8")).toBe(file);
  expect(() => passThrough({ sync: true })).toThrow("tinker(): unknown option sync");
});

test("a missing server option names the exact command config before Start resolves entries", () => {
  const root = fixture({ "vite.config.ts": "export default {};" });
  expect(() => startOptions(root)).toThrow(
    'vite.config.ts: name the server entry with tinker({ serverEntry: "cmds/server.ts" })',
  );
});
