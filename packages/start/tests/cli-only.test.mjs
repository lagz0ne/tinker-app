import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vite-plus/test";

import { generated } from "../lib/checks/generated.mjs";
import { named, say, serverProblems } from "../lib/checks/named.mjs";
import { routes } from "../lib/checks/routes.mjs";
import { aliases } from "../lib/glue.mjs";
import { appFiles, cliOnly } from "../lib/named.mjs";
import { baseDir } from "../lib/paths.mjs";
import { prepare } from "../lib/prepare.mjs";
import { fixture, goodApp } from "./fixture.mjs";

const fromStart = createRequire(join(baseDir, "package.json"));
const core = realpathSync(join(fromStart.resolve("@tinker/core"), "../.."));
const vite = pathToFileURL(fromStart.resolve("vite")).href;

/** The web packages a CLI-only app must never load. */
const web = [
  "react",
  "react-dom",
  "@tanstack/react-start",
  "@tanstack/react-router",
  "@vitejs/plugin-react",
  "@tinker/react",
];

/**
 * A Node hook file that makes any import of a web package throw, so a run under it
 * proves those packages were not needed.
 * @param {string} root - From a test; why: where the hook file goes.
 */
function blockWeb(root) {
  const hook = join(root, "block-web.mjs");
  writeFileSync(
    hook,
    `import { registerHooks } from "node:module";
const web = ${JSON.stringify(web)};
registerHooks({
  resolve(specifier, context, next) {
    if (web.some((name) => specifier === name || specifier.startsWith(name + "/"))) {
      throw new Error("blocked web package: " + specifier);
    }
    return next(specifier, context);
  },
});
`,
  );
  return { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` };
}

/** An app with only cmds/cli.ts: no web entries, no routes, no React. */
function cliApp() {
  const root = fixture({
    "package.json": JSON.stringify({ type: "module", scripts: { postinstall: "tinker prepare" } }),
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({ cliEntry: "cmds/cli.ts" })] };\n',
    "vite.cli.config.ts":
      'import { fileURLToPath } from "node:url";\nexport default { resolve: { alias: { "~": fileURLToPath(new URL("./tinker", import.meta.url)) } }, build: { ssr: "cmds/cli.ts", outDir: "dist-cli" } };\n',
    "tsconfig.json": JSON.stringify({ extends: "./.tinker/tsconfig.json" }),
    ".gitignore": ".tinker/\n.tanstack/\n",
    "tinker/base/main.ts": readFileSync(
      join(baseDir, "../../apps/start-scaffold/tinker/base/main.ts"),
      "utf8",
    ),
    "cmds/cli.ts": [
      'import { defineMain } from "~/base/main";',
      "",
      "export default defineMain(async ({ args, stdout, stderr, exit }) => {",
      "  if (args.length > 0) {",
      '    stderr.write("usage: cli\\n");',
      "    exit(64);",
      "    return { closed: Promise.resolve() };",
      "  }",
      '  stdout.write("hello\\n");',
      "  exit(0);",
      "  return { closed: Promise.resolve() };",
      "});",
      "",
    ].join("\n"),
  });
  mkdirSync(join(root, "node_modules/@tinker"), { recursive: true });
  symlinkSync(baseDir, join(root, "node_modules/@tinker/start"), "dir");
  symlinkSync(core, join(root, "node_modules/@tinker/core"), "dir");
  return root;
}

/**
 * A CLI-only app with Start copied in, as an install leaves it, instead of linked to this repo,
 * where TanStack sits beside it. Only the packages its types read are linked.
 */
function installedCliApp() {
  const root = cliApp();
  const start = join(root, "node_modules/@tinker/start");
  rmSync(start);
  const { files } = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"));
  for (const name of ["package.json", ...files]) {
    cpSync(join(baseDir, name), join(start, name), { recursive: true });
  }

  mkdirSync(join(root, "node_modules/@types"));
  const links = {
    "vite-plus": join(baseDir, "node_modules/vite-plus"),
    "@types/node": join(baseDir, "node_modules/@types/node"),
    vite: join(baseDir, "../../node_modules/vite"),
  };
  for (const [name, from] of Object.entries(links)) {
    symlinkSync(realpathSync(from), join(root, "node_modules", name), "dir");
  }
  return root;
}

/**
 * @param {string} dir - From a test; why: where Node starts its walk up.
 * @param {string} name - From a test; why: the package to look for.
 */
function reachable(dir, name) {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, "node_modules", name))) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * @param {string} root - From a test; why: the app folder.
 * @param {Record<string, string>} env - From blockWeb; why: web packages throw.
 * @param {string} command - From a test; why: the program.
 * @param {string[]} args - From a test; why: its arguments.
 */
function run(root, env, command, args) {
  return spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 120000 });
}

/** A script that loads the app's own vite.config.ts the way Vite does, then names its plugins. */
const loadConfig = `
  const { resolveConfig } = await import(${JSON.stringify(vite)});
  const config = await resolveConfig({ root: process.cwd(), logLevel: "silent" }, "serve");
  console.log(JSON.stringify(config.plugins.map((plugin) => plugin.name)));
`;

test("a CLI-only app with no React passes prepare, doctor, config load, build, and gate:commands", () => {
  const root = cliApp();
  const env = blockWeb(root);
  const tinker = join(baseDir, "bin/tinker.mjs");

  const prepared = run(root, env, process.execPath, [tinker, "prepare"]);
  const doctor = run(root, env, process.execPath, [tinker, "doctor"]);
  const config = run(root, env, process.execPath, ["--input-type=module", "-e", loadConfig]);
  const built = run(root, env, "vp", ["build", "--config", "vite.cli.config.ts"]);
  const gate = run(root, env, process.execPath, [join(baseDir, "lib/command-gate.mjs")]);

  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  expect(prepared.stdout).toBe("tinker prepare: wrote .tinker/tsconfig.json\n");
  expect(existsSync(join(root, ".tinker/routeTree.gen.ts"))).toBe(false);
  expect(doctor.status, doctor.stdout + doctor.stderr).toBe(0);
  expect(doctor.stdout).toContain("skip  5 routes");
  expect(doctor.stdout).toContain("doctor: all checks pass");
  expect(config.status, config.stderr).toBe(0);
  expect(config.stdout).toContain('"tinker:glue"');
  expect(config.stdout).not.toMatch(/tanstack|react/i);
  expect(built.status, built.stdout + built.stderr).toBe(0);
  expect(existsSync(join(root, "dist-cli/cli.js"))).toBe(true);
  expect(gate.status, gate.stdout + gate.stderr).toBe(0);
  expect(gate.stdout).toContain("PASS process command: cmds/cli.ts");
});

test("a CLI-only app type-checks tinker({ cliEntry }) with no TanStack installed", () => {
  const root = installedCliApp();
  prepare(root);
  const tsc = join(baseDir, "node_modules/typescript/bin/tsc");

  const checked = run(root, process.env, process.execPath, [tsc, "--noEmit", "-p", "."]);

  expect(reachable(join(root, "node_modules/@tinker/start"), "@tanstack/react-start")).toBe(false);
  expect(checked.stdout + checked.stderr).toBe("");
  expect(checked.status).toBe(0);
});

test("the web block is real: a web app's config load fails under it", () => {
  const root = goodApp();
  const env = blockWeb(root);

  const config = run(root, env, process.execPath, ["--input-type=module", "-e", loadConfig]);

  expect(config.status).not.toBe(0);
  expect(config.stderr).toContain("blocked web package: @tanstack/react-start");
});

test("cliOnly: cliEntry without serverEntry; a web app, an app with both, and one with neither are not", () => {
  const both = goodApp({
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({ serverEntry: "cmds/server.ts", routerEntry: "cmds/router.ts", startEntry: "cmds/start.ts", cliEntry: "cmds/cli.ts" })] };\n',
  });
  const neither = fixture({ "vite.config.ts": "export default { plugins: [] };\n" });

  expect([cliOnly(cliApp()), cliOnly(goodApp()), cliOnly(both), cliOnly(neither)]).toEqual([
    true,
    false,
    false,
    false,
  ]);
});

test("a CLI-only app's entries, named check, and routes check need no web files", () => {
  const root = cliApp();

  expect(appFiles(root).map(({ option }) => option)).toEqual(["cliEntry"]);
  expect(serverProblems(root)).toEqual([]);
  expect(named(root)).toEqual({
    status: "ok",
    lines: [
      "each named or seam file exports what the base reads (cmds/cli.ts); no Start file is ignored",
    ],
  });
  expect(routes(root)).toEqual({ status: "skip", lines: ["a CLI-only app has no routes"] });
  expect(appFiles(goodApp()).map(({ option }) => option)).toEqual([
    "routerEntry",
    "startEntry",
    "serverEntry",
  ]);
  expect(serverProblems(fixture({ "vite.config.ts": "export default {};\n" }))).toEqual([
    say.noEntry,
  ]);
  const noEntry = fixture({
    "vite.config.ts": "export default {};\n",
    "src/routeTree.gen.ts": "export {};\n",
  });
  expect(named(noEntry)).toEqual({ status: "fail", lines: [say.noEntry], fix: undefined });
});

test("a CLI-only app's generated folder has no route tree to check", () => {
  const root = cliApp();
  const web = goodApp();
  prepare(root);
  prepare(web);

  expect(generated(root).status).toBe("ok");
  expect(generated(web).lines.join("\n")).toContain(".tinker/routeTree.gen.ts is missing");
});

test("a CLI-only app's .gitignore needs only .tinker/; a web app's also needs .tanstack/", () => {
  const listed = cliApp();
  const bare = cliApp();
  const web = goodApp();
  for (const [root, text] of [
    [listed, ".tinker/\n"],
    [bare, "dist/\n"],
    [web, ".tinker/\n"],
  ]) {
    prepare(root);
    writeFileSync(join(root, ".gitignore"), text);
  }

  const missing = generated(bare);

  expect(generated(listed)).toEqual({
    status: "ok",
    lines: [".tinker/ matches this base; .gitignore lists .tinker/"],
  });
  expect(missing.lines).toEqual([".gitignore does not list .tinker/"]);
  expect(missing.fix()).toBe("ran tinker prepare; added .tinker/ to .gitignore");
  expect(readFileSync(join(bare, ".gitignore"), "utf8")).toBe("dist/\n.tinker/\n");
  expect(generated(web).lines).toContain(".gitignore does not list .tanstack/");
});

test("only an app with a server entry gets the #tinker/server-main alias", () => {
  const server = (root) =>
    aliases(root).filter(({ find }) => find.source === "^#tinker\\/server-main$");
  const web = goodApp();

  expect(server(cliApp())).toEqual([]);
  expect(server(web)).toEqual([
    { find: /^#tinker\/server-main$/, replacement: join(web, "cmds/server.ts") },
  ]);
  expect(aliases(cliApp()).map(({ find }) => find.source)).toEqual([
    "^~\\/",
    "^@\\/",
    "^#tinker\\/routes$",
  ]);
});
