import { existsSync } from "node:fs";
import { join } from "node:path";
import { lineOfKey, prependExtends, readJsonc, writeKey } from "../jsonc.mjs";
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
  extends: 'tsconfig.json:1 does not extend "./.tinker/tsconfig.json"',
  paths: (line) =>
    `tsconfig.json:${line} sets compilerOptions.paths; it replaces the base's #tinker/* and @/* paths, so remove it`,
  strict: (line) => `tsconfig.json:${line} turns strict off; the base's files need strict`,
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

/** @param {ReturnType<typeof readJsonc>} tsconfig - From the glue check; why: the parsed tsconfig.json. */
function tsconfigProblems(tsconfig) {
  if (tsconfig.error) return [say.parse("tsconfig.json", tsconfig.error)];
  const { extends: parent, compilerOptions = {} } = tsconfig.value;
  return [
    ![parent].flat().includes(tinkerConfig) && say.extends,
    "paths" in compilerOptions && say.paths(lineOfKey(tsconfig.text, ["compilerOptions", "paths"])),
    compilerOptions.strict === false &&
      say.strict(lineOfKey(tsconfig.text, ["compilerOptions", "strict"])),
  ];
}

/** @param {ReturnType<typeof readJsonc>} pkg - From the glue check; why: the parsed package.json. */
function postinstallProblems(pkg) {
  if (pkg.error) return [say.parse("package.json", pkg.error)];
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
 * `.tinker/` and overrides no base option; postinstall runs `tinker prepare`.
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
    ...tsconfigProblems(read.tsconfig),
    ...postinstallProblems(read.pkg),
  ].filter(Boolean);
  const fixable = problems.some((line) => line === say.extends || line === say.postinstall);
  return verdict(
    problems,
    say.passed(file),
    fixable ? () => fixGlue(root, read, problems) : undefined,
  );
}
