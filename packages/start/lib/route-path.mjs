/** File-name tokens that add no URL segment when they end a route file's name. */
const silentEnds = new Set(["index", "route", "lazy"]);

/**
 * TanStack skips a file or folder that starts with "-"; `__root` is the shell, not a page.
 * @param {string} file - From a walk of src/routes; why: judge that one path.
 */
export function isRouteFile(file) {
  const parts = file.split("/");
  return (
    /\.[jt]sx?$/.test(file) && !parts.some((part) => part.startsWith("-")) && file !== "__root.tsx"
  );
}

/**
 * A route file's path split into segments: folders and dots both split; `[.]` escapes a dot.
 * @param {string} file - From a walk of src/routes; why: the path decides the route.
 */
function segmentsOf(file) {
  return file
    .replace(/\.[jt]sx?$/, "")
    .split("/")
    .flatMap((part) => part.match(/(\[[^\]]*\]|[^.])+/g) ?? []);
}

/**
 * The id TanStack's generator writes into `createFileRoute("…")`: groups and `_pathless`
 * parts stay, and an index route ends in a slash.
 * @param {string} file - From a walk of src/routes; why: the path decides the id.
 */
export function routeId(file) {
  const segments = segmentsOf(file);
  if (segments.at(-1) === "lazy") segments.pop();
  const index = segments.at(-1) === "index";
  if (index || segments.at(-1) === "route") segments.pop();
  const id = `/${segments.join("/")}`;
  return index && segments.length > 0 ? `${id}/` : id;
}

/**
 * The URL a route file serves, read from its path the way TanStack's generator reads it:
 * folders and dots split segments; `(group)`, `_pathless`, and an ending index add none.
 * @param {string} file - From a walk of src/routes; why: the path decides the route.
 * @param {boolean} keepUnnest - From routeClash; why: a trailing "_" leaves the parent route.
 */
export function routePath(file, keepUnnest = false) {
  const segments = segmentsOf(file);
  while (silentEnds.has(segments.at(-1))) segments.pop();
  const served = segments
    .filter((part) => !/^\(.+\)$/.test(part) && !part.startsWith("_"))
    .map((part) => (keepUnnest ? part : part.replace(/_$/, "")).replace(/\[(.*?)\]/g, "$1"));
  return `/${served.join("/")}`;
}

/**
 * How a user route file collides with a route the base mounts, or null.
 * @param {string} file - From a walk of src/routes; why: the user route to judge.
 * @param {string[]} owned - From the base's package.json; why: the paths the base mounts.
 */
export function routeClash(file, owned) {
  const same = owned.find((path) => path === routePath(file));
  if (same) return `takes ${same}, a base route`;
  const under = owned.find((path) => routePath(file, true).startsWith(`${path}/`));
  if (under) return `nests under ${under}, a base route with no outlet; the base page renders`;
  return null;
}
