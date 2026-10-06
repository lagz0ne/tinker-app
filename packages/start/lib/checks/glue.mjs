import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { byteOrderMark, lineOfKey, prependExtends, readJsonc, writeKey } from "../jsonc.mjs";
import { callsOf, importsFrom, parseSource, specifiers } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  noVite: "vite.config.ts is missing; add one with plugins: [tinker()]",
  noImport: (file) => `${file}:1 does not import tinker from "@tinker/start/vite"`,
  noCall: (file, line) => `${file}:${line} does not call tinker(); add plugins: [tinker()]`,
  calls: (file, line, count) =>
    `${file}:${line} calls tinker() ${count} times; call it once: plugins: [tinker()]`,
  start: (file, line) => `${file}:${line} adds tanstackStart(); tinker() adds it already`,
  tailwind: (file, line) =>
    `${file}:${line} imports @tailwindcss/vite; tinker() adds Tailwind already`,
  parse: (file, { line, code }) =>
    `${file}:${line} does not parse (${code}); doctor never edits a file that does not parse`,
  mark: (file) => `${file}:1 starts with a byte order mark; vp cannot read it`,
  extends: 'tsconfig.json:1 does not extend "./.tinker/tsconfig.json"',
  paths: (file, line) =>
    `${file}:${line} sets compilerOptions.paths; it replaces the base's #tinker/* and @/* paths, so remove it`,
  strict: (file, line) => `${file}:${line} turns strict off; the base's files need strict`,
  postinstall:
    'package.json:1 has no "postinstall": "tinker prepare"; a fresh clone has no .tinker/',
  passed: (file) =>
    `${file} calls tinker() once; tsconfig.json extends .tinker; postinstall runs tinker prepare`,
  fixed: (written) => `wrote ${written.join(" and ")}`,
};

/** The generated tsconfig the app's tsconfig.json must extend; an array of files may hold it. */
const tinkerConfig = "./.tinker/tsconfig.json";

/** The config file names Vite looks for, in its order. */
const viteConfigs = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

/**
 * A second tinker() or a tanstackStart() breaks the build later, with a Start error that names
 * no cause ("Duplicate declaration"); so these glue lines stop the build at its start.
 * A missing tinker() call cannot reach here: without it, the base never loads.
 * @param {string} line - From the glue check; why: one finding.
 */
export function breaksBuild(line) {
  return /^vite\.config\.[mc]?[jt]s:\d+ (calls tinker\(\) \d+ times|adds tanstackStart\(\))/.test(
    line,
  );
}

/**
 * The calls to tinker under the name it is imported as, and to Start's own plugin.
 * @param {ReturnType<typeof parseSource>} source - From viteProblems; why: the parsed config.
 */
function pluginCalls(source) {
  const glue = importsFrom(source, "@tinker/start/vite").find(
    ({ imported }) => imported === "tinker",
  );
  const start = importsFrom(source, "@tanstack/react-start/plugin/vite").map(({ local }) => local);
  return {
    glue,
    calls: glue ? callsOf(source, glue.local) : [],
    start: [...new Set(["tanstackStart", ...start])].flatMap((name) => callsOf(source, name)),
  };
}

/**
 * @param {string} root - From the glue check; why: parse its Vite config.
 * @param {string | undefined} file - From the glue check; why: the config file Vite loads.
 */
function viteProblems(root, file) {
  if (!file) return [say.noVite];
  const source = parseSource(join(root, file));
  const { glue, calls, start } = pluginCalls(source);
  const tailwind = specifiers(source).find(({ name }) => name === "@tailwindcss/vite");
  return [
    !glue && say.noImport(file),
    glue && calls.length === 0 && say.noCall(file, glue.line),
    calls.length > 1 && say.calls(file, calls[1], calls.length),
    start.length > 0 && say.start(file, start[0]),
    tailwind && say.tailwind(file, tailwind.line),
  ];
}

/**
 * @param {string} file - From the glue check; why: the file that did not parse.
 * @param {{ line: number, code: string }} error - From readJsonc; why: where and why.
 */
function parseProblem(file, error) {
  return error.code === byteOrderMark ? say.mark(file) : say.parse(file, error);
}

/**
 * Where tsc finds an extended file: the path itself when it is a file, else the path with `.json`
 * added (a folder of that name does not count).
 * @param {string} dir - From extendedChain; why: an extends path is relative to its file.
 * @param {string} entry - From an extends list; why: the path as written.
 */
function extendedPath(dir, entry) {
  const path = resolve(dir, entry);
  return statSync(path, { throwIfNoEntry: false })?.isFile() || path.endsWith(".json")
    ? path
    : `${path}.json`;
}

/**
 * The local files a tsconfig extends after the base's, the winner first. tsc applies an
 * extends list in order, each file after its own chain, so the last file wins, then its chain.
 * A file read once is never read again, so a loop ends.
 * @param {string} root - From overriding; why: the base's tsconfig and each name are found there.
 * @param {string} path - From overriding; why: the file whose extends list this reads.
 * @param {{ value?: Record<string, any> }} read - From readJsonc; why: that file, parsed.
 * @param {Set<string>} seen - From overriding; why: the files read so far.
 */
function extendedChain(root, path, read, seen) {
  const list = [read.value?.extends ?? []]
    .flat()
    .filter((file) => /^\.{1,2}\//.test(file))
    .map((file) => extendedPath(dirname(path), file));
  const files = [];
  for (const file of list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const parent = readJsonc(file);
    files.push(
      { file: relative(root, file), read: parent },
      ...extendedChain(root, file, parent, seen),
    );
  }
  return files;
}

/**
 * The tsconfig files that can override the base's, as tsc reads them, the winner first: the
 * app's own, then each local file its extends chain names after .tinker.
 * @param {string} root - From tsconfigProblems; why: an extended path resolves from the app folder.
 * @param {{ text: string, value: Record<string, any> }} tsconfig - From readJsonc; why: the app's tsconfig.json.
 */
function overriding(root, tsconfig) {
  const own = join(root, "tsconfig.json");
  return [
    { file: "tsconfig.json", read: tsconfig },
    ...extendedChain(root, own, tsconfig, new Set([own])),
  ];
}

/**
 * Where tsc takes a compiler option from: the first file that sets it, its value, and its line.
 * @param {ReturnType<typeof overriding>} files - From tsconfigProblems; why: the winner first.
 * @param {string} key - From tsconfigProblems; why: the compiler option.
 */
function winner(files, key) {
  const found = files.find(({ read }) => read.value?.compilerOptions?.[key] !== undefined);
  if (!found) return undefined;
  const { file, read } = found;
  return {
    file,
    value: read.value.compilerOptions[key],
    line: lineOfKey(read.text, ["compilerOptions", key]),
  };
}

/**
 * @param {string} root - From the glue check; why: read the files tsconfig.json extends.
 * @param {ReturnType<typeof readJsonc>} tsconfig - From the glue check; why: the parsed tsconfig.json.
 */
function tsconfigProblems(root, tsconfig) {
  if (tsconfig.error) return [parseProblem("tsconfig.json", tsconfig.error)];
  const { extends: parent } = tsconfig.value;
  const files = overriding(root, tsconfig);
  const paths = winner(files, "paths");
  const strict = winner(files, "strict");
  return [
    ![parent].flat().includes(tinkerConfig) && say.extends,
    ...files
      .filter(({ read }) => read.error)
      .map(({ file, read }) => parseProblem(file, read.error)),
    paths && say.paths(paths.file, paths.line),
    strict?.value === false && say.strict(strict.file, strict.line),
  ];
}

/** @param {ReturnType<typeof readJsonc>} pkg - From the glue check; why: the parsed package.json. */
function postinstallProblems(pkg) {
  if (pkg.error) return [parseProblem("package.json", pkg.error)];
  const { scripts = {} } = pkg.value;
  return [!/\btinker prepare\b/.test(scripts.postinstall ?? "") && say.postinstall];
}

/**
 * Write only the two keys the base owns; every other byte of both files stays.
 * Only a file that parsed is ever written.
 * @param {string} root - From the glue check; why: the app's folder.
 * @param {{ tsconfig: object, pkg: object }} read - From the glue check; why: the parsed files.
 * @param {string[]} problems - From the glue check; why: write only the keys that are wrong.
 */
function fixGlue(root, read, problems) {
  const written = [];
  if (problems.includes(say.extends)) {
    prependExtends(join(root, "tsconfig.json"), read.tsconfig, tinkerConfig);
    written.push("the extends line in tsconfig.json");
  }
  if (problems.includes(say.postinstall)) {
    writeKey(join(root, "package.json"), read.pkg, ["scripts", "postinstall"], "tinker prepare");
    written.push("the postinstall script in package.json");
  }
  return say.fixed(written);
}

/**
 * Check 4: the Vite config calls tinker() once and adds nothing it owns; tsconfig.json extends
 * `.tinker/`, and neither it nor a local file it extends after `.tinker/` overrides a base
 * option; postinstall runs `tinker prepare`.
 * `--fix` writes the extends key and the postinstall script, and keeps the rest of each file;
 * it never edits the Vite config, nor a file that does not parse.
 */
export function glue(root) {
  const read = {
    tsconfig: readJsonc(join(root, "tsconfig.json")),
    pkg: readJsonc(join(root, "package.json"), { strict: true }),
  };
  const file = viteConfigs.find((name) => existsSync(join(root, name)));
  const problems = [
    ...viteProblems(root, file),
    ...tsconfigProblems(root, read.tsconfig),
    ...postinstallProblems(read.pkg),
  ].filter(Boolean);
  const fixable = problems.some((line) => line === say.extends || line === say.postinstall);
  return verdict(
    problems,
    say.passed(file),
    fixable ? () => fixGlue(root, read, problems) : undefined,
  );
}
