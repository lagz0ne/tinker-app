import { existsSync } from "node:fs";
import { join } from "node:path";

import { shellFile } from "../named.mjs";
import { listFiles } from "../paths.mjs";
import { isRouteFile, routeId, routePath } from "../route-path.mjs";
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
  id: (at, value, id) =>
    `${at} createFileRoute(${value === null ? "" : `"${value}"`}) does not match its file; set it to "${id}", or TanStack's generator rewrites it in src/`,
  passed: () => "route files export Route; the app owns every path",
};

/**
 * @param {string} dir - From the routes check; why: the app's src/routes folder.
 * @param {string} file - From the route walk; why: one route file.
 * @param {{ path: string, part?: string }[]} mounted - From mountedRoutes; why: the base's paths.
 */
function routeProblems(dir, file) {
  const [call] = stringCallsOf(parseSource(join(dir, file)), "createFileRoute");
  const at = `src/routes/${file}:${call?.line ?? 1}`;
  const id = routeId(file);
  return [
    !mayExport(join(dir, file), "Route") && say.export(at, routePath(file)),
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
  if (!existsSync(path)) return [`${shellFile} is missing; copy the app page shell`];

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
  const problems = listFiles(dir)
    .filter(isRouteFile)
    .flatMap((file) => routeProblems(dir, file));
  return verdict([...problems, ...shellProblems(root)].filter(Boolean), say.passed());
}
