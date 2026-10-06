import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { generated, generatorBlocked, staleTree } from "../../lib/checks/generated.mjs";
import { runCheck } from "../../lib/doctor.mjs";
import { basePackage } from "../../lib/paths.mjs";
import { prepare, render } from "../../lib/prepare.mjs";
import { fixture, goodApp, write } from "../fixture.mjs";

const tree = "import { Route as IndexRouteImport } from './../src/routes/index'\n";

/** A good app after `tinker prepare`: .tinker/ written, the route tree naming its one route. */
function preparedApp(files = {}) {
  const root = goodApp(files);
  prepare(root);
  write(root, { ".tinker/routeTree.gen.ts": tree });
  return root;
}

const later = { "src/routes/later.tsx": 'export const Route = createFileRoute("/later")({});\n' };

test("passes when .tinker/ matches, the tree has every route, and .gitignore lists both folders", () => {
  expect(generated(preparedApp())).toEqual({
    status: "ok",
    lines: [".tinker/ matches this base and src/routes; .gitignore lists .tinker/ and .tanstack/"],
  });
});

test("fails when .tinker/ is missing", () => {
  expect(generated(goodApp()).lines).toEqual([".tinker/ is missing; run tinker prepare"]);
});

test("names a stale generated file and a missing route tree", () => {
  const root = goodApp();
  prepare(root);
  write(root, { ".tinker/tsconfig.json": "{}" });
  expect(generated(root).lines).toEqual([
    ".tinker/tsconfig.json is stale; run tinker prepare",
    ".tinker/routeTree.gen.ts is missing; run tinker prepare",
  ]);
});

test("a lazy route counts as in the tree: the tree imports it with import()", () => {
  const root = preparedApp({
    "src/routes/about.lazy.tsx": 'export const Route = createLazyFileRoute("/about")({});\n',
  });
  write(root, {
    ".tinker/routeTree.gen.ts": `${tree}const About = createFileRoute('/about')().lazy(() => import('./../src/routes/about.lazy').then((d) => d.Route))\n`,
  });
  expect(generated(root).status).toBe("ok");
});

test("names a route file the tree misses", () => {
  const root = preparedApp({
    "src/routes/later.tsx": 'export const Route = createFileRoute("/later")({});\n',
  });
  expect(generated(root).lines).toEqual([
    ".tinker/routeTree.gen.ts misses src/routes/later.tsx; run tinker prepare",
  ]);
});

test("while check 7 fails, a missed route says to fix check 7 first; a file with no Route is check 7's", () => {
  const root = preparedApp({
    "src/routes/later.tsx": 'export const Route = createFileRoute("/later")({});\n',
    "src/routes/broken.tsx": "export const route = 1;\n",
  });
  expect(generated(root).lines).toEqual([
    ".tinker/routeTree.gen.ts misses src/routes/later.tsx; fix check 7 first, then run tinker prepare",
  ]);
});

test("a route file that re-exports Route from another file counts as a route", () => {
  const root = preparedApp({
    "src/routes/about.tsx": 'export * from "../frontend/about-page.tsx";\n',
    "src/frontend/about-page.tsx": 'export const Route = createFileRoute("/about")({});\n',
  });
  expect(generated(root).lines).toEqual([
    ".tinker/routeTree.gen.ts misses src/routes/about.tsx; run tinker prepare",
  ]);
});

test("leaves a route that clashes with the base to check 7, not to tinker prepare", () => {
  const root = preparedApp({
    "src/routes/tinker.tsx": 'export const Route = createFileRoute("/tinker")({});\n',
  });
  expect(generated(root).status).toBe("ok");
});

test("when the generator ran and the tree is still stale, tinker prepare says so", () => {
  const root = preparedApp(later);
  expect(staleTree(root)).toEqual([
    "tinker prepare: the route generator left the tree stale; fix the lines below:",
    ".tinker/routeTree.gen.ts misses src/routes/later.tsx; the route generator stopped; see its error above",
  ]);
  expect(staleTree(preparedApp())).toEqual([]);
});

test("while check 7 fails, every route tree line says to fix check 7 first", () => {
  const root = goodApp({ "src/routes/broken.tsx": "export const route = 1;\n" });
  prepare(root);
  expect(generated(root).lines).toEqual([
    ".tinker/routeTree.gen.ts is missing; fix check 7 first, then run tinker prepare",
  ]);
});

test("tinker prepare skips the generator while check 7 fails, and says why", () => {
  const root = preparedApp({
    "src/routes/about.tsx": 'export const Route = createFileRoute("/abuot")({});\n',
  });
  expect(generatorBlocked(root)).toEqual([
    "tinker prepare: check 7 fails, so the route generator did not run (it would stop, or write src/); fix the lines below:",
    'src/routes/about.tsx:1 createFileRoute("/abuot") does not match its file; set it to "/about", or TanStack\'s generator rewrites it in src/',
  ]);
  expect(generatorBlocked(preparedApp())).toEqual([]);
});

test("names a tree import that points at a base folder that moved", () => {
  const root = preparedApp();
  write(root, {
    ".tinker/routeTree.gen.ts": `${tree}import { Route as R } from './../../old-base/src/routes/root'\n`,
  });
  expect(generated(root).lines).toEqual([
    ".tinker/routeTree.gen.ts:2 imports ./../../old-base/src/routes/root, which does not exist; run tinker prepare",
  ]);
});

test("names each generated folder .gitignore does not list", () => {
  const root = preparedApp({ ".gitignore": "dist/\n" });
  expect(generated(root).lines).toEqual([
    ".gitignore does not list .tinker/",
    ".gitignore does not list .tanstack/",
  ]);
});

test("refuses to judge with another base's tinker", () => {
  const root = fixture({
    "package.json": "{}",
    "node_modules/@tinker/start/package.json": JSON.stringify({
      version: "0.0.9",
      exports: { "./package.json": "./package.json" },
    }),
  });
  expect(generated(root).lines).toEqual([
    `this tinker is base ${basePackage.version}, the app resolves 0.0.9; run the app's own tinker`,
  ]);
});

test("--fix starts a new line in a .gitignore that does not end in one", () => {
  const root = preparedApp({ ".gitignore": "node_modules\ndist" });
  expect(runCheck(root, generated, true).status).toBe("fixed");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
    "node_modules\ndist\n.tinker/\n.tanstack/\n",
  );
});

test("--fix appends to a .gitignore that ends in a newline, and says when it adds nothing", () => {
  const root = preparedApp({ ".gitignore": "node_modules\n" });
  expect(runCheck(root, generated, true).status).toBe("fixed");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
    "node_modules\n.tinker/\n.tanstack/\n",
  );
  write(root, { ".tinker/tsconfig.json": "{}" });
  expect(runCheck(root, generated, true)).toEqual({
    status: "fixed",
    lines: ["ran tinker prepare"],
  });
});

/**
 * A fake `vite` with the one call `tinker prepare` makes: it notes that the route generator ran
 * (the real one would write the tree), so a test sees whether --fix ran it. No Vite runs.
 */
const fakeVite = (onResolve) => ({
  "node_modules/vite/package.json": JSON.stringify({
    name: "vite",
    type: "module",
    exports: "./index.js",
  }),
  "node_modules/vite/index.js": `import { writeFileSync } from "node:fs";\nexport async function resolveConfig({ root }) {\n  writeFileSync(root + "/.generator-ran", "1");\n  ${onResolve}\n}\n`,
});

test("--fix never runs the generator while a route clashes: check 3's lines come back", () => {
  const clash = 'export const Route = createFileRoute("/tinker")({});\n';
  const root = preparedApp({ ...fakeVite(""), ...later, "src/routes/tinker.tsx": clash });
  expect(runCheck(root, generated, true)).toMatchObject({
    status: "fail",
    lines: [
      ".tinker/routeTree.gen.ts misses src/routes/later.tsx; fix check 7 first, then run tinker prepare",
    ],
  });
  expect(existsSync(join(root, ".generator-ran"))).toBe(false);
  expect(readFileSync(join(root, "src/routes/tinker.tsx"), "utf8")).toBe(clash);
});

test("--fix runs the generator when check 7 passes; a prepare that fails leaves check 3's lines, not a crash", () => {
  const root = preparedApp({ ...fakeVite('throw new Error("generator failed");'), ...later });
  expect(runCheck(root, generated, true)).toMatchObject({
    status: "fail",
    lines: [".tinker/routeTree.gen.ts misses src/routes/later.tsx; run tinker prepare"],
  });
  expect(existsSync(join(root, ".generator-ran"))).toBe(true);
});

test("--fix rewrites .tinker/ and adds the missing .gitignore lines", () => {
  const root = preparedApp({ ".gitignore": "" });
  write(root, { ".tinker/tsconfig.json": "{}" });
  expect(runCheck(root, generated, true)).toEqual({
    status: "fixed",
    lines: ["ran tinker prepare; added .tinker/ .tanstack/ to .gitignore"],
  });
  expect(readFileSync(join(root, ".tinker/tsconfig.json"), "utf8")).toBe(
    render(root)["tsconfig.json"],
  );
});
