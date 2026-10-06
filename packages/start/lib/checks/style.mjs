import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { shellFile } from "../named.mjs";
import { lineOfKey, readJsonc } from "../jsonc.mjs";
import { installedVersion, lineAt, listFiles, readText } from "../paths.mjs";
import { parseSource, specifiers } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  shell: `${shellFile}:1 replaces the base shell and does not link src/style.css; import style from "../style.css?url" and add { rel: "stylesheet", href: style } to head links`,
  unlinked: (file) =>
    `${file}:1 is never linked: nothing imports it, and the shell links only src/style.css`,
  needs: (line, name) =>
    `src/style.css:${line} imports tailwindcss, but ${name} is not installed; tinker() adds Tailwind when it is`,
  aliasOut: (line, name, alias, target) =>
    `components.json:${line} aliases.${name} "${alias}" lands at ${target}, outside src/; shadcn writes there`,
  aliasNone: (line, name, alias) =>
    `components.json:${line} aliases.${name} "${alias}" matches no tsconfig path`,
  css: (line, css) =>
    `components.json:${line} tailwind.css is "${css}"; the base links src/style.css`,
  noCss: 'components.json:1 sets no tailwind.css; set it to "src/style.css"',
  noStyle: (ui) =>
    `src/style.css is missing; shadcn's files in ${ui} need it, with @import "tailwindcss"`,
  noTailwind: (ui) =>
    `src/style.css:1 does not @import "tailwindcss"; shadcn's files in ${ui} need Tailwind`,
  parse: ({ line, code }) => `components.json:${line} does not parse (${code})`,
  passed: (styled) =>
    styled
      ? "src/style.css is linked by the shell; every stylesheet is linked"
      : "no src/style.css; every stylesheet is linked",
};

/**
 * The paths shadcn reads, as tsconfig-paths merges them: the app's own, else the last extended
 * file that sets them (an extends array, as tsc reads it; a package name is skipped). Null when
 * a tsconfig does not parse: check 4 names that line, so the alias lines here would only guess.
 * @param {string} root - From componentsProblems; why: the app's tsconfig.json.
 */
function mergedPaths(root) {
  const own = readJsonc(join(root, "tsconfig.json"));
  if (own.error) return null;
  const parents = [own.value.extends ?? []]
    .flat()
    .filter((file) => /^\.{1,2}\//.test(file))
    .map((file) => readJsonc(resolve(root, file)));
  if (parents.some((parent) => parent.error)) return null;
  const found = [own, ...parents.reverse()].find((read) => read.value.compilerOptions?.paths);
  return found?.value.compilerOptions.paths ?? {};
}

/**
 * Where shadcn writes for one alias: like tsconfig-paths, it resolves the merged paths from
 * the app folder, even when they come from an extended file.
 * @param {string} root - From aliasProblems; why: shadcn resolves from there.
 * @param {Record<string, string[]>} paths - From mergedPaths; why: the table shadcn reads.
 * @param {string} alias - From components.json; why: the import path to place.
 */
function aliasTarget(root, paths, alias) {
  for (const [key, [target]] of Object.entries(paths)) {
    const prefix = key.replace(/\*$/, "");
    if (key.endsWith("*") ? alias.startsWith(prefix) : alias === key)
      return resolve(root, target.replace("*", alias.slice(prefix.length)));
  }
  return null;
}

/**
 * @param {string} root - From componentsProblems; why: shadcn resolves from the app folder.
 * @param {string} text - From components.json; why: each alias's line.
 * @param {Record<string, string>} aliases - From components.json; why: where shadcn writes.
 * @param {Record<string, string[]>} paths - From mergedPaths; why: the table shadcn reads.
 */
function aliasProblems(root, text, aliases, paths) {
  const src = join(root, "src");
  return Object.entries(aliases).map(([name, alias]) => {
    const line = lineOfKey(text, ["aliases", name]);
    const target = aliasTarget(root, paths, alias);
    if (!target) return say.aliasNone(line, name, alias);
    const inside = target === src || target.startsWith(src + sep);
    return inside ? null : say.aliasOut(line, name, alias, relative(root, target));
  });
}

/**
 * @param {string} text - From components.json; why: the line of tailwind.css.
 * @param {string | undefined} css - From components.json; why: the file shadcn writes CSS to.
 */
function cssProblem(text, css) {
  if (css === undefined) return say.noCss;
  return css === "src/style.css" ? null : say.css(lineOfKey(text, ["tailwind", "css"]), css);
}

/** @param {string} root - From the style check; why: shadcn's settings and their lines. */
function componentsProblems(root) {
  const components = readJsonc(join(root, "components.json"), { strict: true });
  if (components.error) return [say.parse(components.error)];
  if (!components.text) return [];
  const { text, value } = components;
  const { aliases = {}, tailwind = {} } = value;
  const paths = mergedPaths(root);
  if (!paths) return [];
  return [
    ...aliasProblems(root, text, aliases, paths),
    cssProblem(text, tailwind.css),
    ...uiProblems(root, aliases.ui && aliasTarget(root, paths, aliases.ui)),
  ];
}

/**
 * shadcn's UI files need Tailwind from src/style.css; a components.json with no UI file yet
 * (an app template writes it up front) needs nothing.
 * @param {string} root - From componentsProblems; why: the stylesheet lives there.
 * @param {string | null | undefined} ui - From components.json; why: the folder shadcn adds UI files to.
 */
function uiProblems(root, ui) {
  if (!ui || listFiles(ui).length === 0) return [];
  const style = cssText(join(root, "src/style.css"));
  const where = relative(root, ui);
  if (!existsSync(join(root, "src/style.css"))) return [say.noStyle(where)];
  return /@import\s+["']tailwindcss["']/.test(style) ? [] : [say.noTailwind(where)];
}

/**
 * A stylesheet's text with its comments blanked, keeping every line where it was,
 * so a commented-out `@import` never counts.
 * @param {string} path - From a style rule; why: the stylesheet to read.
 */
function cssText(path) {
  return readText(path).replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** @param {string} root - From the style check; why: Tailwind needs both packages in the app. */
function tailwindProblems(root) {
  const style = cssText(join(root, "src/style.css"));
  const at = style.search(/@import\s+["']tailwindcss["']/);
  if (at < 0) return [];
  return ["tailwindcss", "@tailwindcss/vite"]
    .filter((name) => !installedVersion(root, name))
    .map((name) => say.needs(lineAt(style, at), name));
}

/** @param {string} path - From linkedSheets; why: the module paths one stylesheet or source file names. */
function linksOf(path) {
  if (path.endsWith(".css"))
    return [...cssText(path).matchAll(/@import\s+["']([^"']+)["']/g)].map((match) => match[1]);
  if (/\.[jt]sx?$/.test(path)) return specifiers(parseSource(path)).map(({ name }) => name);
  return [];
}

/**
 * Every stylesheet some file in src/ links, by absolute path; `?url` and `@/` are read too.
 * @param {string} root - From unlinkedProblems; why: walk its src/.
 * @param {string[]} files - From unlinkedProblems; why: every file under src/.
 */
function linkedSheets(root, files) {
  const src = join(root, "src");
  return new Set(
    files.flatMap((file) =>
      linksOf(join(src, file))
        .map((name) => name.replace(/\?.*$/, ""))
        .map((name) =>
          name.startsWith("@/")
            ? join(src, name.slice(2))
            : resolve(dirname(join(src, file)), name),
        ),
    ),
  );
}

/** @param {string} root - From the style check; why: a stylesheet nobody links styles nothing. */
function unlinkedProblems(root) {
  const files = listFiles(join(root, "src"));
  const linked = linkedSheets(root, files);
  return files
    .filter((file) => file.endsWith(".css") && file !== "style.css")
    .filter((file) => !linked.has(join(root, "src", file)))
    .map((file) => say.unlinked(`src/${file}`));
}

/**
 * Whether the user's shell imports src/style.css with `?url`, read from its import lines:
 * a comment or a string that merely names the file does not count.
 * @param {string} root - From the style check; why: the shell and the stylesheet live there.
 */
function linksStyle(root) {
  const shell = join(root, shellFile);
  const sheet = join(root, "src/style.css");
  return specifiers(parseSource(shell)).some(({ name }) => {
    const [path, query = ""] = name.split("?");
    const target = path.startsWith("@/")
      ? join(root, "src", path.slice(2))
      : resolve(dirname(shell), path);
    return target === sheet && query.split("&").includes("url");
  });
}

/**
 * Check 8: the page gets its styles. A user shell links src/style.css, no stylesheet sits
 * unlinked, Tailwind's packages are there when the stylesheet imports it, and shadcn's
 * aliases land inside src/. No fix: these are app files.
 */
export function style(root) {
  const styled = existsSync(join(root, "src/style.css"));
  const problems = [
    styled && existsSync(join(root, shellFile)) && !linksStyle(root) && say.shell,
    ...unlinkedProblems(root),
    ...tailwindProblems(root),
    ...componentsProblems(root),
  ];
  return verdict(problems.filter(Boolean), say.passed(styled));
}
