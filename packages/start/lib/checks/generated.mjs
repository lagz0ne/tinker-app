import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepare, render } from "../prepare.mjs";
import {
  baseDir,
  basePackage,
  installedBase,
  lineAt,
  listFiles,
  readJson,
  readText,
} from "../paths.mjs";
import { isRouteFile, routeClash } from "../route-path.mjs";
import { ownedPaths, routes } from "./routes.mjs";
import { mayExport } from "../source.mjs";
import { fail, verdict } from "./result.mjs";

export const say = {
  otherBase: (running, resolved) =>
    `this tinker is base ${running}, the app resolves ${resolved}; run the app's own tinker`,
  missing: ".tinker/ is missing; run tinker prepare",
  stale: (name) => `.tinker/${name} is stale; run tinker prepare`,
  noTree: (next) => `.tinker/routeTree.gen.ts is missing; ${next}`,
  gone: (line, path, next) =>
    `.tinker/routeTree.gen.ts:${line} imports ${path}, which does not exist; ${next}`,
  misses: (file, next) => `.tinker/routeTree.gen.ts misses ${file}; ${next}`,
  prepareNext: "run tinker prepare",
  check7Next: "fix check 7 first, then run tinker prepare",
  generatorNext: "the route generator stopped; see its error above",
  ignore: (entry) => `.gitignore does not list ${entry}`,
  generator: "tinker prepare: the route generator left the tree stale; fix the lines below:",
  notRun:
    "tinker prepare: check 7 fails, so the route generator did not run (it would stop, or write src/); fix the lines below:",
  passed: ".tinker/ matches this base and src/routes; .gitignore lists .tinker/ and .tanstack/",
  fixed: (added) =>
    `ran tinker prepare${added.length > 0 ? `; added ${added.join(" ")} to .gitignore` : ""}`,
};

/** Generated folders the app's .gitignore must list. */
const ignored = [".tinker/", ".tanstack/"];

/** @param {string} root - From the generated check; why: compare the running tinker with the app's base. */
function otherBase(root) {
  const dir = installedBase(root);
  const found = dir && readJson(join(dir, "package.json")).version;
  return found && found !== basePackage.version ? say.otherBase(basePackage.version, found) : null;
}

/**
 * Each relative import in the route tree, resolved to a file on disk (or not): static imports,
 * and the `import('./…')` a lazy route (`about.lazy.tsx`) gets.
 * @param {string} tree - From treeGaps; why: the generated file's path.
 */
function treeImports(tree) {
  const text = readFileSync(tree, "utf8");
  return [...text.matchAll(/(?:from |import\()'(\.[^']+)'/g)].map((match) => {
    const base = resolve(dirname(tree), match[1]);
    const file = ["", ".tsx", ".ts", ".jsx", ".js"].map((ext) => base + ext).find(existsSync);
    return { path: match[1], line: lineAt(text, match.index), base, file };
  });
}

/**
 * What the route tree lacks: no tree at all, imports of files that are gone, and route files
 * that export `Route` (as TanStack reads them) but are not in it.
 * @param {string} root - From check 3 or tinker prepare; why: the app to compare.
 */
function treeGaps(root) {
  const tree = join(root, ".tinker/routeTree.gen.ts");
  if (!existsSync(tree)) return { noTree: true, gone: [], misses: [] };
  const imports = treeImports(tree);
  const listed = new Set(imports.map(({ base }) => base));
  const routesDir = join(root, "src/routes");
  const misses = listFiles(routesDir)
    .filter((file) => isRouteFile(file) && mayExport(join(routesDir, file), "Route"))
    .filter((file) => !listed.has(join(routesDir, file.replace(/\.[jt]sx?$/, ""))));
  return { noTree: false, gone: imports.filter(({ file }) => !file), misses };
}

/**
 * Check 3's route tree lines. A route that clashes with a base route is check 7's to name:
 * the generator stops on it. While check 7 fails, the advice is to fix that first.
 * @param {string} root - From folderProblems; why: the app to compare.
 */
function treeProblems(root) {
  const next = routes(root).status === "fail" ? say.check7Next : say.prepareNext;
  const owned = ownedPaths(root);
  return treeLines(treeGaps(root), next, (file) => !routeClash(file, owned));
}

/**
 * The route tree's gaps as lines, each ending in what to do next.
 * @param {ReturnType<typeof treeGaps>} gaps - From treeGaps; why: what the tree lacks.
 * @param {string} next - From the caller; why: the step that heals the tree from here.
 * @param {(file: string) => boolean} [named] - From check 3; why: the missed files it names.
 */
function treeLines(gaps, next, named = () => true) {
  if (gaps.noTree) return [say.noTree(next)];
  return [
    ...gaps.gone.map(({ line, path }) => say.gone(line, path, next)),
    ...gaps.misses.filter(named).map((file) => say.misses(`src/routes/${file}`, next)),
  ];
}

/**
 * Why `tinker prepare` must not run TanStack's generator now: while check 7 fails, the generator
 * would stop on a clash, or rewrite a wrong createFileRoute path or an empty route file in src/.
 * Empty when it may run.
 * @param {string} root - From tinker prepare and check 3's --fix; why: the app to prepare.
 */
export function generatorBlocked(root) {
  const checked = routes(root);
  return checked.status === "fail" ? [say.notRun, ...checked.lines] : [];
}

/**
 * After `tinker prepare` ran the generator: what still keeps the route tree stale, with check 7's
 * lines for why. The generator logs a route clash and stops without failing, so prepare checks.
 * @param {string} root - From tinker prepare; why: the app whose tree was just written.
 */
export function staleTree(root) {
  const lines = treeLines(treeGaps(root), say.generatorNext);
  if (lines.length === 0) return [];
  const checked = routes(root);
  return [say.generator, ...lines, ...(checked.status === "fail" ? checked.lines : [])];
}

/** @param {string} root - From the generated check; why: the folders its .gitignore lacks. */
function unignored(root) {
  const path = join(root, ".gitignore");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  return ignored.filter((entry) => !lines.includes(entry));
}

/**
 * Append the missing lines, after a newline when the file does not end in one,
 * so the last line the user wrote stays a line of its own.
 * @param {string} root - From the generated fix; why: the app's .gitignore.
 * @param {string[]} entries - From unignored; why: the lines to add.
 */
function addIgnored(root, entries) {
  if (entries.length === 0) return;
  const text = readText(join(root, ".gitignore"));
  const lead = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(
    join(root, ".gitignore"),
    `${lead}${entries.map((entry) => `${entry}\n`).join("")}`,
  );
}

/**
 * The route tree half of --fix: `tinker prepare`, which runs TanStack's generator only while
 * check 7 passes (see generatorBlocked), so --fix never writes src/. A failed run is not
 * thrown: the check that runs next reports.
 * @param {string} root - From the generated fix; why: the app to prepare.
 */
function fixTree(root) {
  if (treeLines(treeGaps(root), "").length === 0) return;
  try {
    execFileSync(process.execPath, [join(baseDir, "bin/tinker.mjs"), "prepare"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    return;
  }
}

/** @param {string} root - From the generated check; why: the app whose .tinker/ goes stale. */
function folderProblems(root) {
  const dir = join(root, ".tinker");
  if (!existsSync(dir)) return [say.missing];
  const stale = Object.entries(render(root))
    .filter(
      ([name, text]) =>
        !existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== text,
    )
    .map(([name]) => say.stale(name));
  return [...stale, ...treeProblems(root)];
}

/**
 * Check 3: `.tinker/` matches this base, the route tree has every route file and no
 * dead import, and .gitignore lists the generated folders. `--fix` rewrites `.tinker/` and adds
 * the ignore lines; a stale route tree also needs `tinker prepare`, which loads the app's Vite
 * config, and runs only while check 7 passes (see fixTree).
 */
export function generated(root) {
  const other = otherBase(root);
  if (other) return fail([other]);
  const missing = unignored(root);
  const problems = [...folderProblems(root), ...missing.map(say.ignore)];
  return verdict(problems, say.passed, () => {
    prepare(root);
    addIgnored(root, missing);
    fixTree(root);
    return say.fixed(missing);
  });
}
