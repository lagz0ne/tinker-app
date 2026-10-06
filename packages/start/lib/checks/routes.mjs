import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellFile } from "../named.mjs";
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
  id: (at, value, id) =>
    `${at} createFileRoute(${value === null ? "" : `"${value}"`}) does not match its file; set it to "${id}", or TanStack's generator rewrites it in src/`,
  passed: (owned) => `route files export Route; none takes a base path (${owned.join(", ")})`,
};

/** @param {string} root - From a check; why: read the paths the app's base mounts. */
export function ownedPaths(root) {
  const base = installedBase(root);
  return base ? Object.keys(readJson(join(base, "package.json")).tinker.routes) : [];
}

/**
 * @param {string} dir - From the routes check; why: the app's src/routes folder.
 * @param {string} file - From the route walk; why: one route file.
 * @param {string[]} owned - From ownedPaths; why: the base's own paths.
 */
function routeProblems(dir, file, owned) {
  const [call] = stringCallsOf(parseSource(join(dir, file)), "createFileRoute");
  const at = `src/routes/${file}:${call?.line ?? 1}`;
  const clash = routeClash(file, owned);
  const id = routeId(file);
  return [
    !mayExport(join(dir, file), "Route") && say.export(at, routePath(file)),
    clash && say.clash(at, clash),
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
 * and no route takes or nests under a path the base mounts. No fix.
 */
export function routes(root) {
  const dir = join(root, "src/routes");
  if (!existsSync(dir)) return fail([say.missing]);
  const owned = ownedPaths(root);
  const problems = listFiles(dir)
    .filter(isRouteFile)
    .flatMap((file) => routeProblems(dir, file, owned));
  return verdict([...problems, ...shellProblems(root)].filter(Boolean), say.passed(owned));
}
