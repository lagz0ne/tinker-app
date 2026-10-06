import { expect, test } from "vite-plus/test";
import { isRouteFile, routeClash, routePath } from "../lib/route-path.mjs";

const owned = ["/api/health", "/tinker"];

test("a route's URL drops groups, pathless parts, and the ending index", () => {
  expect(routePath("posts/$id.tsx")).toBe("/posts/$id");
  expect(routePath("api.health.ts")).toBe("/api/health");
  expect(routePath("(marketing)/about.tsx")).toBe("/about");
  expect(routePath("_auth/dashboard.tsx")).toBe("/dashboard");
  expect(routePath("posts/index.tsx")).toBe("/posts");
  expect(routePath("posts/route.tsx")).toBe("/posts");
  expect(routePath("index.tsx")).toBe("/");
  expect(routePath("files/[.]well-known.tsx")).toBe("/files/.well-known");
});

test("all six ways to take a base path clash", () => {
  expect(routeClash("tinker.tsx", owned)).toBe("takes /tinker, a base route");
  expect(routeClash("api.health.ts", owned)).toBe("takes /api/health, a base route");
  expect(routeClash("(extra)/tinker.tsx", owned)).toBe("takes /tinker, a base route");
  expect(routeClash("_wrap/tinker.tsx", owned)).toBe("takes /tinker, a base route");
  expect(routeClash("tinker/index.tsx", owned)).toBe("takes /tinker, a base route");
  expect(routeClash("tinker/settings.tsx", owned)).toBe(
    "nests under /tinker, a base route with no outlet; the base page renders",
  );
});

test("a flat child of a base path nests under it; a trailing _ leaves the parent", () => {
  expect(routeClash("tinker.settings.tsx", owned)).toBe(
    "nests under /tinker, a base route with no outlet; the base page renders",
  );
  expect(routeClash("tinker_.settings.tsx", owned)).toBeNull();
  expect(routeClash("tinkering.tsx", owned)).toBeNull();
  expect(routeClash("api/healthz.ts", owned)).toBeNull();
});

test("files under a - folder and the shell are not routes", () => {
  expect(isRouteFile("-parts/tinker.tsx")).toBe(false);
  expect(isRouteFile("__root.tsx")).toBe(false);
  expect(isRouteFile("notes.md")).toBe(false);
  expect(isRouteFile("posts/$id.tsx")).toBe(true);
});
