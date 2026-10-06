import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * Break each check, glue function, and doctor message in a scratch copy of the base, one at a
 * time, and run the unit tests: every break must make a test fail. A hand-written mutation run.
 * Usage: node packages/start/scripts/break-each-check.mjs
 */
const base = resolve(import.meta.dirname, "..");
const scratch = "/tmp/tinker-break/start";
const passOk = 'return { status: "ok", lines: ["broken"] };';

/** Logic breaks: file, the text to find, what replaces it. */
const breaks = [
  ...[
    "version",
    "bytes",
    "generated",
    "glue",
    "named",
    "imports",
    "routes",
    "style",
    "env",
    "boundary",
  ].map((name) => ({
    name: `check ${name} always passes`,
    file: `lib/checks/${name}.mjs`,
    find: `export function ${name}(root) {`,
    replace: `export function ${name}(root) {\n  ${passOk}`,
  })),
  {
    name: "bytes --fix restores nothing",
    file: "lib/checks/bytes.mjs",
    find: "else writeFileSync(",
    replace: "else if (false) writeFileSync(",
  },
  {
    name: "generated --fix adds no ignore line",
    file: "lib/checks/generated.mjs",
    find: "if (entries.length === 0) return;",
    replace: "return;",
  },
  {
    name: "glue --fix writes no extends",
    file: "lib/checks/glue.mjs",
    find: 'prependExtends(join(root, "tsconfig.json"), read.tsconfig, tinkerConfig);',
    replace: "",
  },
  {
    name: "build start stops nothing",
    file: "lib/doctor.mjs",
    find: "errors: lines.filter(({ stops }) => stops).map(({ text }) => text),",
    replace: "errors: [],",
  },
  {
    name: "build start warns about nothing",
    file: "lib/doctor.mjs",
    find: "warnings: lines.filter(({ stops }) => !stops).map(({ text }) => text),",
    replace: "warnings: [],",
  },
  {
    name: "a fix that fails reads as fixed",
    file: "lib/doctor.mjs",
    find: 'again.status === "ok" ?',
    replace: "true ?",
  },
  { name: "aliases drop ?url", file: "lib/glue.mjs", find: "(\\\\?.*)?$`", replace: "$`" },
  {
    name: "the shell never replaces the base's",
    file: "lib/glue.mjs",
    find: "existsSync(join(root, shellFile))",
    replace: "false",
  },
  {
    name: "an unknown tinker() option is dropped",
    file: "lib/glue.mjs",
    find: "if (unknown.length > 0)",
    replace: "if (false)",
  },
  {
    name: "a named file is never picked",
    file: "lib/named.mjs",
    find: "return existsSync(own) ? own :",
    replace: "return false ? own :",
  },
  {
    name: "src/router.tsx is not listed",
    file: "lib/named.mjs",
    find: '[".ts", ".tsx", ".js", ".jsx"]',
    replace: '[".ts", ".js", ".jsx"]',
  },
  {
    name: "tsconfig @/* goes back to ../src/*",
    file: "lib/prepare.mjs",
    find: '"@/*": [`${join(root, "src")}/*`]',
    replace: '"@/*": ["../src/*"]',
  },
  {
    name: "route groups count as a segment",
    file: "lib/route-path.mjs",
    find: "!/^\\(.+\\)$/.test(part) && ",
    replace: "",
  },
  {
    name: "nesting under a base route is missed",
    file: "lib/route-path.mjs",
    find: ".startsWith(`${path}/`)",
    replace: ".endsWith(`${path}/`)",
  },
  {
    name: "a - folder counts as a route",
    file: "lib/route-path.mjs",
    find: '!parts.some((part) => part.startsWith("-")) && ',
    replace: "",
  },
  {
    name: "tsc errors read as none",
    file: "lib/typecheck.mjs",
    find: ".filter(Boolean)",
    replace: ".filter(() => false)",
  },
  {
    name: "a second tinker() only warns",
    file: "lib/doctor.mjs",
    find: "stops: stopping.has(label) || breaksBuild(line),",
    replace: "stops: stopping.has(label),",
  },
  {
    name: "check 3 sends a clash to tinker prepare",
    file: "lib/checks/generated.mjs",
    find: "(file) => !routeClash(file, owned)",
    replace: "() => true",
  },
  {
    name: "tinker prepare hides a stale tree",
    file: "lib/checks/generated.mjs",
    find: "if (lines.length === 0) return [];",
    replace: "return [];",
  },
  {
    name: "shadcn needs Tailwind before any UI file",
    file: "lib/checks/style.mjs",
    find: "if (!ui || listFiles(ui).length === 0) return [];",
    replace: "if (!ui) return [];",
  },
  {
    name: "vite.config.ts is not type-checked",
    file: "lib/prepare.mjs",
    find: '"../vite.config.ts",',
    replace: "",
  },
  {
    name: "a tsconfig that does not parse reads as empty",
    file: "lib/jsonc.mjs",
    find: "if (!text || errors.length === 0) return { value: value ?? {} };",
    replace: "return { value: value ?? {} };",
  },
  {
    name: "--fix drops the comments of tsconfig.json",
    file: "lib/jsonc.mjs",
    find: "writeBack(path, read, applyEdits(text, edits));",
    replace:
      'writeBack(path, read, JSON.stringify(parse(applyEdits(text, edits)), null, 2) + "\\n");',
  },
  {
    name: "--fix writes a tsconfig that does not parse",
    file: "lib/checks/glue.mjs",
    find: 'if (tsconfig.error) return [parseProblem("tsconfig.json", tsconfig.error)];',
    replace:
      'if (tsconfig.error) return [parseProblem("tsconfig.json", tsconfig.error), say.extends];',
  },
  {
    name: "a renamed tinker import counts no call",
    file: "lib/checks/glue.mjs",
    find: "callsOf(source, glue.local)",
    replace: 'callsOf(source, "tinker")',
  },
  {
    name: "a config with no tinker() call stops the build",
    file: "lib/checks/glue.mjs",
    find: "calls.length > 1 && say.calls(",
    replace: "calls.length !== 1 && say.calls(",
  },
  {
    name: "tinker prepare runs the generator while check 7 fails",
    file: "lib/checks/generated.mjs",
    find: 'return checked.status === "fail" ? [say.notRun, ...checked.lines] : [];',
    replace: "return [];",
  },
  {
    name: ".gitignore gets no newline before the append",
    file: "lib/checks/generated.mjs",
    find: 'const lead = text && !text.endsWith("\\n") ? "\\n" : "";',
    replace: 'const lead = "";',
  },
  {
    name: "export * is never followed",
    file: "lib/source.mjs",
    find: "const target = localModule(from, node.source.value);",
    replace: "const target = null;",
  },
  {
    name: "an export * from a package fails the check",
    file: "lib/source.mjs",
    find: "if (!target) return { names: new Map(), open: true };",
    replace: "if (!target) return { names: new Map(), open: false };",
  },
  {
    name: "the shell link is a text match again",
    file: "lib/checks/style.mjs",
    find: "!linksStyle(root)",
    replace: "!/style\\.css\\?url/.test(readText(join(root, shellFile)))",
  },
  {
    name: "a bad components.json throws",
    file: "lib/checks/style.mjs",
    find: "if (components.error) return [say.parse(components.error)];",
    replace: "",
  },
  {
    name: "a wrong createFileRoute path is not named",
    file: "lib/checks/routes.mjs",
    find: "call.value !== id",
    replace: "false",
  },
  {
    name: "a stale pin is not named",
    file: "lib/checks/version.mjs",
    find: ".filter(([, spec]) => exact.test(spec))",
    replace: ".filter(() => false)",
  },
  {
    name: "tinker prepare wipes the boundary record",
    file: "lib/prepare.mjs",
    find: "  return Object.keys(files);\n}",
    replace:
      '  writeFileSync(join(dir, "violations.json"), "[]\\n");\n  return Object.keys(files);\n}',
  },
  {
    name: "dev restarts on any file",
    file: "lib/hooks.mjs",
    find: "picked.includes(path) ?",
    replace: "true ?",
  },
  {
    name: "a production error page shows the text",
    file: "src/entry/error-detail.ts",
    find: "if (!dev) return undefined;",
    replace: "",
  },
  {
    name: "components.json is read leniently",
    file: "lib/checks/style.mjs",
    find: 'readJsonc(join(root, "components.json"), { strict: true })',
    replace: 'readJsonc(join(root, "components.json"))',
  },
  {
    name: "package.json is read leniently",
    file: "lib/checks/glue.mjs",
    find: 'readJsonc(join(root, "package.json"), { strict: true })',
    replace: 'readJsonc(join(root, "package.json"))',
  },
  {
    name: "a postinstall prepare blocks the install",
    file: "lib/prepare.mjs",
    find: 'lifecycle !== "postinstall"',
    replace: "true",
  },
  {
    name: "check 3 says run tinker prepare while check 7 fails",
    file: "lib/checks/generated.mjs",
    find: 'routes(root).status === "fail" ? say.check7Next : say.prepareNext',
    replace: "say.prepareNext",
  },
  {
    name: "any value named Outlet counts as the outlet",
    file: "lib/checks/routes.mjs",
    find: "(outlet && usesOf(source, outlet.local).length > 0)",
    replace: 'usesOf(source, "Outlet").length > 0',
  },
  {
    name: "a byte order mark breaks the parse",
    file: "lib/jsonc.mjs",
    find: "const marked = raw.startsWith(bom);",
    replace: "const marked = false;",
  },
  {
    name: "--fix drops the byte order mark",
    file: "lib/jsonc.mjs",
    find: '${read.marked ? bom : ""}',
    replace: "",
  },
  {
    name: "--fix always indents with two spaces",
    file: "lib/jsonc.mjs",
    find: "insertSpaces: !tabs,",
    replace: "insertSpaces: true,",
  },
  {
    name: "an extends array never counts",
    file: "lib/checks/glue.mjs",
    find: "![parent].flat().includes(tinkerConfig)",
    replace: "parent !== tinkerConfig",
  },
  {
    name: "a file extended after .tinker is never read",
    file: "lib/checks/glue.mjs",
    find: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()",
    replace: "[]",
  },
  {
    name: "a file extended before .tinker counts too",
    file: "lib/checks/glue.mjs",
    find: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()",
    replace: "list.reverse()",
  },
  {
    name: "the first extended file wins, not the last",
    file: "lib/checks/glue.mjs",
    find: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()",
    replace: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1)",
  },
  {
    name: "an extends name with no .json is not found",
    file: "lib/checks/glue.mjs",
    find: 'path.endsWith(".json") ? path : `${path}.json`',
    replace: "true ? path : path",
  },
  {
    name: "an extended file's own extends is not followed",
    file: "lib/checks/glue.mjs",
    find: "...extendedChain(root, file, parent, seen)",
    replace: "...[]",
  },
  {
    name: "a byte order mark passes strict JSON",
    file: "lib/jsonc.mjs",
    find: "if (strict && marked) return",
    replace: "if (false) return",
  },
  {
    name: "a byte order mark in package.json reads as a parse code",
    file: "lib/checks/glue.mjs",
    find: "error.code === byteOrderMark ? say.mark(file) : ",
    replace: "",
  },
  {
    name: "--fix replaces the extends key",
    file: "lib/jsonc.mjs",
    find: '  if (!node) return writeKey(path, read, ["extends"], entry);',
    replace: '  return writeKey(path, read, ["extends"], entry);',
  },
  {
    name: "lazy routes read as missed",
    file: "lib/checks/generated.mjs",
    find: "(?:from |import\\()'",
    replace: "from '",
  },
  {
    name: "an extends array breaks shadcn's alias read",
    file: "lib/checks/style.mjs",
    find: "[own.value.extends ?? []]\n    .flat()",
    replace: "[own.value.extends ?? []]",
  },
  {
    name: "the type check never runs",
    file: "lib/typecheck.mjs",
    find: "export function checkTypes(root) {",
    replace: "export function checkTypes(root) {\n  return [];",
  },
  {
    name: ".env beats the shell",
    file: "lib/env.mjs",
    find: "if (key in process.env && !fromEnvFile.has(key)) continue;",
    replace: "",
  },
  {
    name: "an edited .env keeps its old value",
    file: "lib/env.mjs",
    find: "process.env[key] = value;",
    replace: "process.env[key] ??= value;",
  },
  {
    name: "serve hands out dot paths",
    file: "lib/serve.mjs",
    find: 'if (path.split("/").some((part) => part.startsWith("."))) return null;',
    replace: "",
  },
  {
    name: "serve skips public/ files",
    file: "lib/serve.mjs",
    find: "const found = await readStatic(file, immutable);",
    replace: "const found = immutable ? await readStatic(file, immutable) : null;",
  },
  {
    name: "upgrade breaks a tarball peer",
    file: "lib/upgrade.mjs",
    find: "if (installed(name) === version) continue;",
    replace: "",
  },
  {
    name: "readResult hides a failure",
    file: "src/backend/result.server.ts",
    find: 'if (result.status === "failed") throw result.error;',
    replace: "",
  },
  {
    name: "the dev error page never shows",
    file: "src/entry/dev-error.ts",
    find: "if (response.status !== 500 || !page || !json) return response;",
    replace: "return response;",
  },
  {
    name: "the default server entry skips the base",
    file: "src/defaults/server.ts",
    find: "next(request)",
    replace: 'new Response("x")',
  },
  {
    name: "a read body ends the request as cancelled",
    file: "src/backend/body.server.ts",
    find: "await finish(!owned.cancelled);",
    replace: "await finish(false);",
  },
];

/** Message breaks: one per entry of each check's `say` table, by adding a mark to its text. */
function messageBreaks() {
  return readdirSync(join(base, "lib/checks"))
    .filter((file) => file !== "result.mjs")
    .concat(["../typecheck.mjs"])
    .flatMap((file) => {
      const path = `lib/checks/${file}`.replace("checks/../", "");
      const text = readFileSync(join(base, path), "utf8");
      const table = text.slice(
        text.indexOf("export const say = {"),
        text.indexOf("\n};", text.indexOf("export const say = {")),
      );
      return [...table.matchAll(/^ {2}(\w+):[^"'`]*?(["'`])/gm)].map((match) => {
        const at = text.indexOf(table) + match.index + match[0].length;
        return { name: `message ${path.split("/").at(-1)} say.${match[1]}`, file: path, at };
      });
    });
}

/** @param {{ file: string, find?: string, replace?: string, at?: number }} change - From the lists above; why: the one edit to make. */
function applyBreak(change) {
  const path = join(scratch, change.file);
  const text = readFileSync(path, "utf8");
  if (change.at !== undefined)
    return writeFileSync(path, `${text.slice(0, change.at)}~${text.slice(change.at)}`);
  if (!text.includes(change.find))
    throw new Error(`break "${change.name}": text not found in ${change.file}`);
  writeFileSync(
    path,
    text.replace(change.find, () => change.replace),
  );
}

/** Copy the base to scratch, sharing its installed packages. */
function freshScratch() {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(base, scratch, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.includes("/packs"),
  });
  symlinkSync(join(base, "node_modules"), join(scratch, "node_modules"), "dir");
}

/**
 * Run the tests in scratch and read the JSON report: vitest exits 1 when a test fails, so the
 * exit code is ignored. A suite that fails to load counts apart: it proves no test.
 */
function failedTests() {
  rmSync("/tmp/tinker-break/out.json", { force: true });
  try {
    execFileSync("vp", ["test", "--reporter=json", "--outputFile=/tmp/tinker-break/out.json"], {
      cwd: scratch,
      stdio: "ignore",
    });
  } catch {}
  const report = JSON.parse(readFileSync("/tmp/tinker-break/out.json", "utf8"));
  const broken = report.testResults.filter((file) => file.assertionResults.length === 0).length;
  return { failed: report.numFailedTests, broken };
}

freshScratch();
const control = failedTests();
console.log(
  `control (no break): ${control.failed} failed test(s), ${control.broken} broken file(s)`,
);
let caught = 0;
const all = [...breaks, ...messageBreaks()];
for (const change of all) {
  freshScratch();
  applyBreak(change);
  const { failed, broken } = failedTests();
  const ok = failed > 0 && broken === 0;
  if (ok) caught += 1;
  console.log(`${ok ? "caught" : "MISSED"}  ${String(failed).padStart(3)} failed  ${change.name}`);
}
console.log(
  `\n${caught} of ${all.length} breaks caught (${breaks.length} logic, ${all.length - breaks.length} message)`,
);
process.exitCode = caught === all.length && control.failed === 0 ? 0 : 1;
