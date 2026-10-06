import { join, relative, resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { aliases, passThrough, startOptions } from "../lib/glue.mjs";
import { appFiles, ignoredFiles } from "../lib/named.mjs";
import { baseDir } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

test("the glue picks up exactly five named files and two seam files", () => {
  expect(appFiles.map(({ file }) => file)).toEqual([
    "src/router.ts",
    "src/start.ts",
    "src/server.ts",
    "src/style.css",
    "src/lib/tinker.ts",
    "src/lib/tinker.server.ts",
  ]);
});

test("an alias points at the app's named file, else at the base default, and keeps ?url", () => {
  const root = fixture({ "src/start.ts": "", "src/style.css": "" });
  const table = aliases(root);
  const imports = [
    "#tinker/start",
    "#tinker/server",
    "#tinker/style?url",
    "#tinker/app.server",
    "#tinker/routes",
    "#tinker/parts",
    "#tinker/parts.server",
    "@/backend/greet.ts",
  ];
  expect(
    imports.map((name) => {
      const alias = table.find(({ find }) => find.test(name));
      return name.replace(alias.find, alias.replacement);
    }),
  ).toEqual([
    join(root, "src/start.ts"),
    join(baseDir, "src/defaults/server.ts"),
    `${join(root, "src/style.css")}?url`,
    join(baseDir, "src/defaults/app.server.ts"),
    join(root, ".tinker/routeTree.gen.ts"),
    join(root, ".tinker/parts.ts"),
    join(root, ".tinker/parts.server.ts"),
    join(root, "src/backend/greet.ts"),
  ]);
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
  expect(files).not.toContain("src/router.ts");
  expect(files).not.toContain("src/start.ts");
  expect(files).not.toContain("src/server.ts");
});

test("Start's entries and base routes point into the base, relative to the app's src", () => {
  const root = fixture({ "src/routes/index.tsx": "" });
  const options = startOptions(root, ["telemetry"]);
  expect(resolve(root, "src", options.server.entry)).toBe(join(baseDir, "src/entry/server.ts"));
  expect(resolve(root, "src", options.router.entry)).toBe(join(baseDir, "src/entry/router.tsx"));
  const { virtualRouteConfig: tree } = options.router;
  expect(resolve(root, "src/routes", tree.file)).toBe(join(baseDir, "src/routes/root.tsx"));
  expect(tree.children.map((child) => child.path ?? child.pathPrefix)).toEqual([
    "/api/health",
    "/tinker",
    "/api/telemetry",
    "",
  ]);
  expect(resolve(root, "src/routes", tree.children[2].file)).toBe(
    join(baseDir, "src/routes/api.telemetry.ts"),
  );
});

test("a part that is off mounts no route, so its path is the app's", () => {
  const root = fixture({ "src/routes/index.tsx": "" });
  const { virtualRouteConfig: tree } = startOptions(root, []).router;
  expect(tree.children.map((child) => child.path ?? child.pathPrefix)).toEqual([
    "/api/health",
    "/tinker",
    "",
  ]);
});

test("Start runs the base's entries, the generated route tree, and the base's import rules", () => {
  const root = fixture({ "src/routes/index.tsx": "" });
  const fromSrc = (file) => relative(join(root, "src"), join(baseDir, "src", file));
  const { virtualRouteConfig, ...router } = startOptions(root, []).router;
  expect({ ...startOptions(root, []), router }).toEqual({
    srcDirectory: "src",
    start: { entry: fromSrc("entry/start.ts") },
    server: { entry: fromSrc("entry/server.ts") },
    router: {
      entry: fromSrc("entry/router.tsx"),
      generatedRouteTree: "../.tinker/routeTree.gen.ts",
    },
    importProtection: {
      behavior: "error",
      client: {
        files: [/\.server\./, /\/backend\//],
        specifiers: ["@tanstack/react-start/server", "@tinker/start/server"],
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
  expect(passThrough({ root: "/app", prerender: { enabled: true } })).toStrictEqual({
    prerender: { enabled: true },
  });
  expect(() => passThrough({ prerendr: {}, sap: {} })).toThrow(
    "tinker(): unknown option prerendr, sap; known: root, prerender, pages, spa, sitemap, telemetry, auth",
  );
  expect(passThrough({ telemetry: false, auth: true, spa: { enabled: true } })).toStrictEqual({
    spa: { enabled: true },
  });
});

test("with auth on, its route mounts at /api/auth/$ from the base", () => {
  const root = fixture({ "src/routes/index.tsx": "" });
  const { virtualRouteConfig: tree } = startOptions(root, ["telemetry", "auth"]).router;
  expect(tree.children.map((child) => child.path ?? child.pathPrefix)).toEqual([
    "/api/health",
    "/tinker",
    "/api/telemetry",
    "/api/auth/$",
    "",
  ]);
  expect(resolve(root, "src/routes", tree.children[3].file)).toBe(
    join(baseDir, "src/routes/api.auth.ts"),
  );
});
