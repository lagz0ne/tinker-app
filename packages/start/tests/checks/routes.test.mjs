import { expect, test } from "vite-plus/test";

import { routes } from "../../lib/checks/routes.mjs";
import { basePackage } from "../../lib/paths.mjs";
import { fixture, goodApp } from "../fixture.mjs";

const page = (path) =>
  `import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("${path}")({});\n`;

test("passes when every route exports Route and none takes a base path", () => {
  expect(routes(goodApp())).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path ()"],
  });
});

test("fails when src/routes is missing", () => {
  expect(routes(fixture({ "package.json": "{}" })).lines).toEqual([
    "src/routes/ is missing; create src/routes/index.tsx",
  ]);
});

test("names a route that exports route, not Route, at its createFileRoute line", () => {
  const root = goodApp({
    "src/routes/index.tsx":
      'import { createFileRoute } from "@tanstack/react-router";\nexport const route = createFileRoute("/")({});\n',
    "src/routes/blank.tsx": "",
  });
  expect(routes(root).lines).toEqual([
    "src/routes/blank.tsx:1 does not export Route; TanStack skips the file, so /blank is a 404",
    "src/routes/index.tsx:2 does not export Route; TanStack skips the file, so / is a 404",
  ]);
});

test("a route that re-exports Route through export * is a route", () => {
  const root = goodApp({
    "src/routes/about.tsx": 'export * from "../frontend/about";\n',
    "src/frontend/about.tsx": 'export const Route = createFileRoute("/about")({});\n',
  });
  expect(routes(root).status).toBe("ok");
});

test("names a createFileRoute path that does not match its file, before the generator rewrites src/", () => {
  const root = goodApp({
    "src/routes/about.tsx": 'export const Route = createFileRoute("/abuot")({});\n',
    "src/routes/posts/index.tsx": "export const Route = createFileRoute()({});\n",
  });
  expect(routes(root).lines).toEqual([
    'src/routes/about.tsx:1 createFileRoute("/abuot") does not match its file; set it to "/about", or TanStack\'s generator rewrites it in src/',
    'src/routes/posts/index.tsx:1 createFileRoute() does not match its file; set it to "/posts/", or TanStack\'s generator rewrites it in src/',
  ]);
});

test("names a shell whose component renders no Outlet", () => {
  const root = goodApp({
    "src/routes/__root.tsx":
      'import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute({\n  component: () => <main>the shell</main>,\n});\n',
  });
  expect(routes(root).lines).toEqual([
    "src/routes/__root.tsx:3 sets component without <Outlet />; no page renders inside the shell",
  ]);
});

test("passes a shell that renders Outlet, uses Outlet as is, or imports its component", () => {
  const shells = [
    'import { Outlet } from "@tanstack/react-router";\nexport const Route = createRootRoute({ component: () => <main><Outlet /></main> });\n',
    'import { Outlet as Slot } from "@tanstack/react-router";\nexport const Route = createRootRoute({ component: () => <Slot /> });\n',
    'import { Outlet } from "@tanstack/react-router";\nexport const Route = createRootRoute({ component: Outlet });\n',
    'import { Layout } from "../layout";\nexport const Route = createRootRoute({ component: Layout });\n',
    "export const Route = createRootRoute({ shellComponent: ({ children }) => children });\n",
  ];
  for (const shell of shells) {
    expect(routes(goodApp({ "src/routes/__root.tsx": shell })).status).toBe("ok");
  }
});

test("a local value named Outlet is not TanStack's outlet", () => {
  const root = goodApp({
    "src/routes/__root.tsx":
      'const Outlet = "nothing";\nexport const Route = createRootRoute({\n  component: () => <main>{Outlet}</main>,\n});\n',
  });
  expect(routes(root).lines).toEqual([
    "src/routes/__root.tsx:3 sets component without <Outlet />; no page renders inside the shell",
  ]);
});

test("names each of the six ways a route takes a legacy package path", () => {
  const root = fixture({
    "node_modules/@tinker/start/package.json": JSON.stringify({
      ...basePackage,
      tinker: {
        ...basePackage.tinker,
        routes: { "/tinker": "src/routes/tinker.tsx", "/api/health": "src/routes/api.health.ts" },
      },
    }),
    "src/routes/tinker.tsx": page("/tinker"),
    "src/routes/api.health.ts": page("/api/health"),
    "src/routes/(extra)/tinker.tsx": page("/(extra)/tinker"),
    "src/routes/_wrap/tinker.tsx": page("/_wrap/tinker"),
    "src/routes/tinker/index.tsx": page("/tinker/"),
    "src/routes/tinker/settings.tsx": page("/tinker/settings"),
    "src/routes/tinker_.own.tsx": page("/tinker_/own"),
  });
  expect(routes(root).lines.sort()).toEqual([
    "src/routes/(extra)/tinker.tsx:2 takes /tinker, a base route",
    "src/routes/_wrap/tinker.tsx:2 takes /tinker, a base route",
    "src/routes/api.health.ts:2 takes /api/health, a base route",
    "src/routes/tinker.tsx:2 takes /tinker, a base route",
    "src/routes/tinker/index.tsx:2 takes /tinker, a base route",
    "src/routes/tinker/settings.tsx:2 nests under /tinker, a base route with no outlet; the base page renders",
  ]);
});

test("copied sync and nested app routes need no package switch", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.8.0", parts: ["auth", "sync"] }),
    "src/routes/api.sync.ts": page("/api/sync"),
    "src/routes/api/sync/raw.ts": page("/api/sync/raw"),
  });
  expect(routes(root)).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path ()"],
  });
});

test("with the part off, as the last tinker() call recorded, its path is the app's", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.3.0", parts: [] }),
    "src/routes/api.telemetry.ts": page("/api/telemetry"),
  });
  expect(routes(root)).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path ()"],
  });
});

test("an installed base from before parts mounts its own routes only", () => {
  const root = fixture({
    "src/routes/api.telemetry.ts": page("/api/telemetry"),
    "node_modules/@tinker/start/package.json": JSON.stringify({
      tinker: { routes: { "/tinker": "src/routes/tinker.tsx" } },
    }),
  });
  expect(routes(root)).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path (/tinker)"],
  });
});

test("with no base installed, no path is the base's", () => {
  const root = fixture({ "src/routes/tinker.tsx": page("/tinker") });
  expect(routes(root)).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path ()"],
  });
});

test("a legacy installed package still reserves its mounted auth route", () => {
  const root = fixture({
    "node_modules/@tinker/start/package.json": JSON.stringify({
      ...basePackage,
      tinker: {
        ...basePackage.tinker,
        parts: {
          ...basePackage.tinker.parts,
          auth: {
            ...basePackage.tinker.parts.auth,
            routes: { "/api/auth/$": "src/routes/api.auth.ts" },
          },
        },
      },
    }),
    ".tinker/base.json": JSON.stringify({ base: "0.4.0", parts: ["telemetry", "auth"] }),
    "src/routes/api.auth.$.ts": page("/api/auth/$"),
    "src/routes/api/auth/login.ts": page("/api/auth/login"),
  });
  expect(routes(root).lines.sort()).toEqual([
    "src/routes/api.auth.$.ts:2 takes /api/auth/$, a base route; tinker({ auth: false }) frees it",
    "src/routes/api/auth/login.ts:2 takes /api/auth/login from /api/auth/$, a base route that answers every path under it; tinker({ auth: false }) frees it",
  ]);
});

test("with auth off, as by default, /api/auth/ is the app's", () => {
  const root = goodApp({
    "src/routes/api.auth.$.ts": page("/api/auth/$"),
    "src/routes/api/auth/login.ts": page("/api/auth/login"),
  });
  expect(routes(root).status).toBe("ok");
});

test("an old sync record does not claim the app's copied route", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.5.0", parts: ["auth", "sync"] }),
    "src/routes/api.sync.ts": page("/api/sync"),
  });
  expect(routes(root)).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path ()"],
  });
  expect(routes(goodApp({ "src/routes/api.sync.ts": page("/api/sync") })).status).toBe("ok");
});

test("copied auth routes belong to the app even when the old auth switch is recorded", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.8.0", parts: ["auth"] }),
    "src/routes/api.auth.$.ts": page("/api/auth/$"),
  });
  expect(routes(root)).toEqual({
    status: "ok",
    lines: ["route files export Route; none takes a base path ()"],
  });
});
