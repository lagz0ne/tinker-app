import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellFile } from "../named.mjs";
import { recordedParts } from "../parts.mjs";
import { installedBase, listFiles, readJson } from "../paths.mjs";
import { isRouteFile, routeClash, routeId, routePath } from "../route-path.mjs";
import {
  importedNames,
  importsFrom,
  mayExport,
  parseSource,
  propertiesOf,
  stringCallsOf,
  usesOf,
} from "../source.mjs";
import { fail, verdict } from "./result.mjs";

export const say = {
  missing: "src/routes/ is missing; create src/routes/index.tsx",
  export: (at, path) => `${at} does not export Route; TanStack skips the file, so ${path} is a 404`,
  outlet: (at) => `${at} sets component without <Outlet />; no page renders inside the shell`,
  clash: (at, why) => `${at} ${why}`,
  partClash: (at, why, part) => `${at} ${why}; tinker({ ${part}: false }) frees it`,
  id: (at, value, id) =>
    `${at} createFileRoute(${value === null ? "" : `"${value}"`}) does not match its file; set it to "${id}", or TanStack's generator rewrites it in src/`,
  passed: (owned) => `route files export Route; none takes a base path (${owned.join(", ")})`,
};

/**
 * The routes the app's installed base mounts: its own, then each on part's, named by its part.
 * An installed base that predates parts mounts its own routes only.
 * @param {string} root - From a check; why: read the app's base and its recorded parts.
 */
function mountedRoutes(root) {
  const base = installedBase(root);
  if (!base) return [];
  const { routes, parts = {} } = readJson(join(base, "package.json")).tinker;
  return [
    ...Object.keys(routes).map((path) => ({ path })),
    ...recordedParts(root)
      .filter((name) => name in parts)
      .flatMap((name) => Object.keys(parts[name].routes).map((path) => ({ path, part: name }))),
  ];
}

/** @param {string} root - From a check; why: read the paths the app's base mounts. */
export function ownedPaths(root) {
  return mountedRoutes(root).map(({ path }) => path);
}

/**
 * How a route file takes a base path, with the switch that frees it when a part mounts it.
 * @param {string} at - From routeProblems; why: the file and line to name.
 * @param {string} file - From the route walk; why: one route file.
 * @param {{ path: string, part?: string }[]} mounted - From mountedRoutes; why: the base's paths.
 */
function clashLine(at, file, mounted) {
  const clash = routeClash(
    file,
    mounted.map(({ path }) => path),
  );
  if (!clash) return null;
  const part = mounted.find(({ path, part }) => part && routeClash(file, [path]))?.part;
  return part ? say.partClash(at, clash, part) : say.clash(at, clash);
}

/**
 * @param {string} dir - From the routes check; why: the app's src/routes folder.
 * @param {string} file - From the route walk; why: one route file.
 * @param {{ path: string, part?: string }[]} mounted - From mountedRoutes; why: the base's paths.
 */
function routeProblems(dir, file, mounted) {
  const [call] = stringCallsOf(parseSource(join(dir, file)), "createFileRoute");
  const at = `src/routes/${file}:${call?.line ?? 1}`;
  const id = routeId(file);
  return [
    !mayExport(join(dir, file), "Route") && say.export(at, routePath(file)),
    clashLine(at, file, mounted),
    call && !file.includes("[") && call.value !== id && say.id(at, call.value, id),
  ];
}

/**
 * A shell's `component` must render TanStack's `<Outlet />`, read by the name it is imported
 * under, unless the component comes from another file. A local value named Outlet does not count.
 * @param {string} root - From the routes check; why: the app's shell lives there.
 */
function shellProblems(root) {
  const path = join(root, shellFile);
  if (!existsSync(path)) return [];
  const source = parseSource(path);
  const imported = importedNames(source);
  const outlet = importsFrom(source, "@tanstack/react-router").find(
    ({ imported: name }) => name === "Outlet",
  );
  const component = propertiesOf(source, "component").find(
    ({ value }) =>
      !(value.type === "Identifier" && imported.has(value.name) && value.name !== outlet?.local),
  );
  if (!component || (outlet && usesOf(source, outlet.local).length > 0)) return [];
  return [say.outlet(`${shellFile}:${source.line(component)}`)];
}

/**
 * Check 7: src/routes exists, each route file exports `Route`, the shell renders an outlet,
 * and no route takes or nests under a path the base mounts, an on part's included. No fix.
 */
export function routes(root) {
  const dir = join(root, "src/routes");
  if (!existsSync(dir)) return fail([say.missing]);
  const mounted = mountedRoutes(root);
  const problems = listFiles(dir)
    .filter(isRouteFile)
    .flatMap((file) => routeProblems(dir, file, mounted));
  return verdict(
    [...problems, ...shellProblems(root)].filter(Boolean),
    say.passed(mounted.map(({ path }) => path)),
  );
}
