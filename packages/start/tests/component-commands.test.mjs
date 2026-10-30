// Card 6, phase 1: the contract for `tinker add | update | check`, written before the code.
//
// State table for update (component `u`, registry copy moves v1 -> v2):
//
// | state before update       | folder | .new | .old | result after update                  |
// |---------------------------|--------|------|------|--------------------------------------|
// | clean                     | v1     | -    | -    | v2, no .tinker/update                |
// | .new left from a crash    | v1     | junk | -    | v2, no .tinker/update (junk dropped) |
// | .old left, folder absent  | -      | v2   | v1   | restore v1, then v2 (U1c)            |
// | .old left, folder present | v1     | -    | junk | v2, no .tinker/update (junk dropped) |
//
// Crash at step k: k = copy into .new (U1a), k = the swap rename (U1b), k = after the first
// rename, folder gone and .old left (U1c).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  rename as renameAsync,
  rm as rmAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

import { updateComponent } from "../lib/component-commands.mjs";
import { baseDir, listFiles } from "../lib/paths.mjs";

const bin = join(baseDir, "bin/tinker.mjs");
const startMin = resolve(baseDir, "../../apps/start-min");
const scaffoldRegistry = resolve(baseDir, "../../apps/start-scaffold/public/r");

const usage =
  "usage: tinker prepare | doctor [--fix] | serve | add <name> | update <name> [--force] | check [--registry <path|url>]";

/** A temp folder, removed when the test ends. @param {string} [prefix] - From a test; why: name it. */
function tempDir(prefix = "tinker-cmd-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write `target -> text` pairs under `root`; `~/` is the app root.
 * @param {string} root - From a test; why: the app or registry folder to write in.
 * @param {Record<string, string>} files - From a test; why: what to write.
 */
function writeFiles(root, files) {
  for (const [target, text] of Object.entries(files)) {
    const file = join(root, target.replace(/^~\//, ""));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** @param {object} [extra] - From a test; why: dependencies to start with. */
function packageJson(extra = {}) {
  const pkg = { name: "app", version: "0.0.0", private: true, type: "module", ...extra };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** @param {Record<string, string>} [files] - From a test; why: what the app holds. */
function app(files = {}) {
  const root = tempDir();
  writeFiles(root, { "package.json": packageJson(), ...files });
  return root;
}

/** @param {string} root - From a test; why: the app. @param {string} file - From a test; why: the file. */
function read(root, file) {
  return readFileSync(join(root, file.replace(/^~\//, "")), "utf8");
}

/** @param {string} root - From a test; why: the app whose package.json changed. */
function readPackage(root) {
  return JSON.parse(read(root, "package.json"));
}

/** @param {Buffer | string} bytes - From a snapshot; why: compare content, not time. */
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} top - From a test; why: hash every file under it. */
function snapshot(top) {
  return Object.fromEntries(
    listFiles(top, top)
      .sort()
      .map((file) => [file, sha(readFileSync(join(top, file)))]),
  );
}

/**
 * The hashes a registry item's files give a folder, as folder-relative paths.
 * @param {Record<string, string>} files - From a fixture item; why: target -> content.
 * @param {string} top - From a test; why: the folder those files land in.
 */
function filesUnder(files, top) {
  const found = {};
  for (const [target, content] of Object.entries(files)) {
    const file = target.replace(/^~\//, "");
    if (file.startsWith(`${top}/`)) found[file.slice(top.length + 1)] = sha(Buffer.from(content));
  }
  return found;
}

/**
 * Run the bin in `root`.
 * @param {string} root - From a test; why: the app is the cwd.
 * @param {...string} args - From a test; why: the command and its flags.
 */
function tinker(root, ...args) {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
  const out = run.stdout.trim();
  return { code: run.status, out, lines: out === "" ? [] : out.split("\n") };
}

/**
 * A component folder's files, with `index.ts` exporting `<name>Value`.
 * @param {string} name - From a fixture item; why: the component's name.
 * @param {string[]} [requires] - From a fixture item; why: what its component.json lists.
 * @param {Record<string, string>} [extra] - From a fixture item; why: files to add.
 */
function componentFiles(name, requires = [], extra = {}) {
  const list = requires.map((item) => `"${item}"`).join(", ");
  return {
    [`~/tinker/components/${name}/component.json`]: `{ "requires": [${list}] }\n`,
    [`~/tinker/components/${name}/index.ts`]: `export const ${name}Value = "${name}";\n`,
    ...extra,
  };
}

const aIndex = `export const aRuntime = 1;

export function aHelper() {
  return aRuntime;
}

export type { AType } from "./types";
`;

const uV1 = {
  "~/tinker/components/u/component.json": '{ "requires": [] }\n',
  "~/tinker/components/u/index.ts": "export const uVersion = 1;\n",
  "~/tinker/components/u/stale.ts": "export const stale = true;\n",
};

const uV2 = {
  "~/tinker/components/u/component.json": '{ "requires": [] }\n',
  "~/tinker/components/u/index.ts": "export const uVersion = 2;\n",
  "~/tinker/components/u/fresh.ts": "export const fresh = true;\n",
};

const items = {
  a: {
    files: {
      "~/tinker/components/a/component.json": '{ "requires": ["b"] }\n',
      "~/tinker/components/a/index.ts": aIndex,
      "~/tinker/components/a/index.server.ts":
        'export const aServer = 1;\n\nexport { aRuntime } from "./index";\n',
    },
    dependencies: ["left-pad@1.3.0"],
    devDependencies: ["@types/left-pad@^1"],
  },
  b: { files: componentFiles("b", ["c"]), dependencies: ["@scope/bee@2.0.0"] },
  c: { files: componentFiles("c") },
  s: {
    files: componentFiles("s"),
    meta: { starterOnly: true, starterOnlyWhy: "it runs only inside the starter" },
  },
  "s-default": { files: componentFiles("s-default"), meta: { starterOnly: true } },
  t: { files: componentFiles("t", ["s"]) },
  m: {
    files: {
      "~/tinker/components/m/component.json": '{ "requires": [] }\n',
      "~/tinker/components/m/index.ts": 'export const mValue = "m";\n',
      "~/drizzle/1_m/migration.sql": "-- 1_m\n",
    },
  },
  p: { files: componentFiles("p", ["q"]) },
  q: { files: componentFiles("q", ["p"]) },
  u: { files: uV1 },
  x: { files: { "~/src/demo.ts": "export const demo = 1;\n" } },
  bad: {
    files: {
      "~/tinker/components/bad/component.json": '{ "requires": [] }\n',
      "~/../x": "export const escape = 1;\n",
    },
  },
  "bad-src": {
    files: {
      "~/tinker/components/bad-src/component.json": '{ "requires": [] }\n',
      "~/src/z.ts": "export const z = 1;\n",
    },
  },
  "bad-other": {
    files: {
      "~/tinker/components/bad-other/component.json": '{ "requires": [] }\n',
      "~/tinker/components/a/index.ts": "export const aRuntime = 1;\n",
    },
  },
  Upper: { files: componentFiles("Upper") },
  up: { files: componentFiles("up", ["Upper"]) },
};

/**
 * One item JSON in the fixture registry.
 * @param {string} dir - From makeRegistry; why: the registry folder.
 * @param {string} name - From a fixture item; why: the item's name.
 * @param {{ files: Record<string, string>, dependencies?: string[], devDependencies?: string[] }} spec - From items; why: the item's files and deps.
 */
function writeItem(dir, name, spec) {
  const item = {
    name,
    type: "registry:component",
    files: Object.entries(spec.files).map(([target, content]) => ({
      target,
      type: "registry:file",
      content,
    })),
    ...(spec.dependencies ? { dependencies: spec.dependencies } : {}),
    ...(spec.devDependencies ? { devDependencies: spec.devDependencies } : {}),
  };
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(item, null, 2)}\n`);
}

/**
 * The fixture registry's index: what exists, and which items are starter-only.
 * @param {string} dir - From makeRegistry; why: the registry folder.
 * @param {Record<string, { meta?: object }>} specs - From makeRegistry; why: the item list.
 */
function writeIndex(dir, specs) {
  const index = {
    name: "tinker-test",
    items: Object.entries(specs).map(([name, spec]) => ({
      name,
      type: "registry:component",
      ...(spec.meta ? { meta: spec.meta } : {}),
      registryDependencies: [],
    })),
  };
  writeFileSync(join(dir, "registry.json"), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * A fixture registry folder: `registry.json` plus one `<name>.json` per item.
 * @param {Record<string, object>} [tweaks] - From a test; why: items to change or add.
 */
function makeRegistry(tweaks = {}) {
  const dir = tempDir("tinker-registry-");
  const specs = { ...items, ...tweaks };
  writeIndex(dir, specs);
  for (const [name, spec] of Object.entries(specs)) writeItem(dir, name, spec);
  return dir;
}

/**
 * Change one item in a registry already built (a new registry version).
 * @param {string} dir - From a test; why: the registry folder.
 * @param {string} name - From a test; why: the item to replace.
 * @param {{ files: Record<string, string>, dependencies?: string[] }} spec - From a test; why: the new shape.
 */
function setItem(dir, name, spec) {
  writeItem(dir, name, spec);
}

/** An fs whose second write into `.tinker/update/` throws: a copy that fails half-way. */
function copyFailureFs() {
  let writes = 0;
  return {
    async writeFile(file, data, options) {
      if (String(file).includes(".tinker/update/")) {
        writes += 1;
        if (writes === 2) throw new Error("EIO: simulated copy failure");
      }
      return writeFileAsync(file, data, options);
    },
  };
}

/**
 * An fs whose `.new` -> folder rename throws: the swap fails after the old folder moved.
 * @param {string} folder - From a test; why: the component folder the rename targets.
 */
function swapFailureFs(folder) {
  return {
    async rename(from, to) {
      if (String(from).endsWith(".new") && String(to) === folder) {
        throw new Error("EXDEV: simulated swap failure");
      }
      return renameAsync(from, to);
    },
  };
}

/**
 * Run the bin in `root` without blocking this process, for the fixture server that runs here.
 * @param {string} root - From a test; why: the app is the cwd.
 * @param {...string} args - From a test; why: the command and its flags.
 */
function tinkerAsync(root, ...args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      const out = stdout.trim();
      done({ code, out, lines: out === "" ? [] : out.split("\n") });
    });
  });
}

/**
 * An item the index lists but whose item file is missing: a 404 from the base.
 * @param {string} dir - From a test; why: the registry folder.
 */
function addGhost(dir) {
  const index = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
  index.items.push({ name: "ghost", type: "registry:component", registryDependencies: [] });
  writeFileSync(join(dir, "registry.json"), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Serve a registry folder over http, so `--registry` can be a URL.
 * @param {string} dir - From a test; why: the folder to serve.
 */
async function serveRegistry(dir) {
  const server = createServer((request, response) => {
    const path = join(dir, new URL(request.url, "http://127.0.0.1").pathname);
    if (!existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(readFileSync(path));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("U1a a copy that fails half-way leaves the old folder whole", async () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);
  const before = snapshot(join(root, "tinker/components/u"));

  await expect(
    updateComponent(root, "u", registry, { force: true, fs: copyFailureFs() }),
  ).rejects.toThrow("simulated copy failure");

  expect(snapshot(join(root, "tinker/components/u"))).toEqual(before);
});

test("U1b a swap that fails on the second rename leaves the old folder whole", async () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);
  const folder = join(root, "tinker/components/u");
  const before = snapshot(folder);

  await expect(
    updateComponent(root, "u", registry, { force: true, fs: swapFailureFs(folder) }),
  ).rejects.toThrow("simulated swap failure");

  expect(snapshot(folder)).toEqual(before);
});

test("U1c an update killed after the first rename is restored and then completes", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app({
    ".tinker/update/u.old/component.json": '{ "requires": [] }\n',
    ".tinker/update/u.old/index.ts": "export const uVersion = 1;\n",
    ".tinker/update/u.old/stale.ts": "export const stale = true;\n",
    ".tinker/update/u.new/component.json": '{ "requires": [] }\n',
    ".tinker/update/u.new/index.ts": "export const uVersion = 2;\n",
    ".tinker/update/u.new/fresh.ts": "export const fresh = true;\n",
  });

  const interrupted = tinker(root, "check", "--registry", registry);
  expect(interrupted.code).toBe(1);
  expect(interrupted.lines).toEqual([
    "interrupted update: u; run tinker update u",
    "tinker check: 1 findings",
  ]);
  expect(existsSync(join(root, ".tinker/update/u.old"))).toBe(true);

  const done = tinker(root, "update", "u", "--registry", registry);
  expect(done.code).toBe(0);
  expect(done.lines).toEqual([
    "restored tinker/components/u from an interrupted update",
    "tinker update: replaced tinker/components/u; run tsc (npm run typecheck) to see breaks in your code",
  ]);
  expect(snapshot(join(root, "tinker/components/u"))).toEqual(
    filesUnder(uV2, "tinker/components/u"),
  );
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("U2 a successful update leaves exactly the registry files", () => {
  const registry = makeRegistry();
  setItem(registry, "u", { files: uV2 });
  const root = app(uV1);

  expect(tinker(root, "update", "u", "--force", "--registry", registry).code).toBe(0);

  expect(snapshot(join(root, "tinker/components/u"))).toEqual(
    filesUnder(uV2, "tinker/components/u"),
  );
  expect(existsSync(join(root, "tinker/components/u/stale.ts"))).toBe(false);
  expect(read(root, "tinker/components/u/index.ts")).toBe("export const uVersion = 2;\n");
});

test("U3a no temp folder is left after a failed copy", async () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);

  await expect(
    updateComponent(root, "u", registry, { force: true, fs: copyFailureFs() }),
  ).rejects.toThrow("simulated copy failure");

  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("U3b no temp folder is left after a failed swap", async () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);

  await expect(
    updateComponent(root, "u", registry, {
      force: true,
      fs: swapFailureFs(join(root, "tinker/components/u")),
    }),
  ).rejects.toThrow("simulated swap failure");

  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("U3c no temp folder is left after a successful update", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);

  expect(tinker(root, "update", "u", "--force", "--registry", registry).code).toBe(0);
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
  expect(listFiles(join(root, ".tinker"), join(root, ".tinker"))).toEqual([]);
});

test("N1 copy fails half-way: the old folder keeps its file list and its bytes", async () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);
  const folder = join(root, "tinker/components/u");

  await expect(
    updateComponent(root, "u", registry, { force: true, fs: copyFailureFs() }),
  ).rejects.toThrow("simulated copy failure");

  expect(listFiles(folder, folder).sort()).toEqual(["component.json", "index.ts", "stale.ts"]);
  expect(read(root, "tinker/components/u/component.json")).toBe('{ "requires": [] }\n');
  expect(read(root, "tinker/components/u/index.ts")).toBe("export const uVersion = 1;\n");
  expect(read(root, "tinker/components/u/stale.ts")).toBe("export const stale = true;\n");
});

test("N2 junk in the temp copy folder before an update is dropped", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);

  writeFiles(root, { ".tinker/update/u.new/junk.ts": "export const junk = 1;\n" });

  expect(tinker(root, "update", "u", "--force", "--registry", registry).code).toBe(0);
  expect(snapshot(join(root, "tinker/components/u"))).toEqual(
    filesUnder(uV2, "tinker/components/u"),
  );
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("N3 an update with both temp folders left from a crash still replaces and cleans up", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);

  writeFiles(root, {
    ".tinker/update/u.new/junk.ts": "export const junk = 1;\n",
    ".tinker/update/u.old/junk.ts": "export const junk = 1;\n",
  });

  expect(tinker(root, "update", "u", "--force", "--registry", registry).code).toBe(0);
  expect(snapshot(join(root, "tinker/components/u"))).toEqual(
    filesUnder(uV2, "tinker/components/u"),
  );
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("A1 add copies the closure, merges deps, and prints the paste lines", () => {
  const registry = makeRegistry();
  const root = app();

  const run = tinker(root, "add", "a", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines).toEqual([
    "run your package manager's install (npm install / pnpm install)",
    "Paste what you use into cmds/*.ts (tinker add writes no wiring):",
    'import { cValue } from "~/components/c";',
    'import { bValue } from "~/components/b";',
    'import { aHelper, aRuntime } from "~/components/a";',
    'import { aRuntime, aServer } from "~/components/a/index.server";',
    "tinker add: added c, b, a",
  ]);
  expect(snapshot(join(root, "tinker/components/c"))).toEqual(
    filesUnder(items.c.files, "tinker/components/c"),
  );
  expect(snapshot(join(root, "tinker/components/a"))).toEqual(
    filesUnder(items.a.files, "tinker/components/a"),
  );
  expect(readPackage(root).dependencies).toEqual({
    "left-pad": "1.3.0",
    "@scope/bee": "2.0.0",
  });
  expect(readPackage(root).devDependencies).toEqual({ "@types/left-pad": "^1" });
});

test("A2 add keeps a requires member that is already here, byte for byte", () => {
  const registry = makeRegistry();
  const root = app({
    ...componentFiles("c"),
    "~/tinker/components/c/index.ts": 'export const cValue = "edited by me";\n',
  });

  const run = tinker(root, "add", "a", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines).toEqual([
    "kept tinker/components/c (already here)",
    "run your package manager's install (npm install / pnpm install)",
    "Paste what you use into cmds/*.ts (tinker add writes no wiring):",
    'import { bValue } from "~/components/b";',
    'import { aHelper, aRuntime } from "~/components/a";',
    'import { aRuntime, aServer } from "~/components/a/index.server";',
    "tinker add: added b, a",
  ]);
  expect(read(root, "tinker/components/c/index.ts")).toBe(
    'export const cValue = "edited by me";\n',
  );
});

test("A3 add refuses an item that is not in the index", () => {
  const registry = makeRegistry();
  const root = app();
  const before = snapshot(root);

  const run = tinker(root, "add", "nope", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["unknown component: nope"]);
  expect(snapshot(root)).toEqual(before);
});

test("A3 add refuses an item that is not a component", () => {
  const registry = makeRegistry();
  const root = app();
  const before = snapshot(root);

  const run = tinker(root, "add", "x", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["x is not a component; tinker add copies tinker/components/x only"]);
  expect(snapshot(root)).toEqual(before);
});

test("A3 add refuses starter-only items, asked for or required", () => {
  const registry = makeRegistry();
  const direct = app();
  const required = app();
  const before = [snapshot(direct), snapshot(required)];

  const askS = tinker(direct, "add", "s", "--registry", registry);
  expect(askS.code).toBe(1);
  expect(askS.lines).toEqual(["s is starter-only: it runs only inside the starter"]);

  const askDefault = tinker(direct, "add", "s-default", "--registry", registry);
  expect(askDefault.code).toBe(1);
  expect(askDefault.lines).toEqual(["s-default is starter-only: it needs the starter's toolchain"]);

  const askT = tinker(required, "add", "t", "--registry", registry);
  expect(askT.code).toBe(1);
  expect(askT.lines).toEqual(["s is starter-only: it runs only inside the starter"]);

  expect([snapshot(direct), snapshot(required)]).toEqual(before);
});

test("A3 add refuses a component that is already here", () => {
  const registry = makeRegistry();
  const root = app(componentFiles("a", ["b"]));
  const before = snapshot(root);

  const run = tinker(root, "add", "a", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["a is already added; use tinker update a"]);
  expect(snapshot(root)).toEqual(before);
});

test("A3 add refuses a target that would leave the app root", () => {
  const registry = makeRegistry();
  const root = app();
  const before = snapshot(root);

  const run = tinker(root, "add", "bad", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["bad target ~/../x in bad"]);
  expect(snapshot(root)).toEqual(before);
});

test("A4 add writes outside files and refuses a conflicting one", () => {
  const registry = makeRegistry();
  const added = app();

  const ok = tinker(added, "add", "m", "--registry", registry);
  expect(ok.code).toBe(0);
  expect(read(added, "drizzle/1_m/migration.sql")).toBe("-- 1_m\n");
  expect(existsSync(join(added, "tinker/components/m/index.ts"))).toBe(true);

  const clash = app({ "~/drizzle/1_m/migration.sql": "-- mine\n" });
  const before = snapshot(clash);
  const bad = tinker(clash, "add", "m", "--registry", registry);
  expect(bad.code).toBe(1);
  expect(bad.lines).toEqual(["conflict: drizzle/1_m/migration.sql"]);
  expect(snapshot(clash)).toEqual(before);
});

test("A5 add keeps a present dep with a different spec and writes nothing when nothing is new", () => {
  const registry = makeRegistry();
  const differing = app({
    "package.json": packageJson({ dependencies: { "left-pad": "^1.3.0" } }),
  });

  const merged = tinker(differing, "add", "a", "--registry", registry);
  expect(merged.code).toBe(0);
  expect(merged.lines).toContain("kept left-pad@^1.3.0 (registry: 1.3.0)");
  expect(readPackage(differing).dependencies["left-pad"]).toBe("^1.3.0");

  const same = app({
    "package.json": packageJson({
      dependencies: { "left-pad": "1.3.0", "@scope/bee": "2.0.0" },
      devDependencies: { "@types/left-pad": "^1" },
    }),
  });
  const before = read(same, "package.json");
  const kept = tinker(same, "add", "a", "--registry", registry);
  expect(kept.code).toBe(0);
  expect(kept.lines).not.toContain(
    "run your package manager's install (npm install / pnpm install)",
  );
  expect(read(same, "package.json")).toBe(before);
});

test("A6 a requires cycle terminates and adds both components", () => {
  const registry = makeRegistry();
  const root = app();

  const run = tinker(root, "add", "p", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines.at(-1)).toBe("tinker add: added q, p");
  expect(existsSync(join(root, "tinker/components/p/index.ts"))).toBe(true);
  expect(existsSync(join(root, "tinker/components/q/index.ts"))).toBe(true);
});

test("P1 add and update never write under cmds/ or src/", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app({
    ...uV1,
    "cmds/server.ts": "export const server = 1;\n",
    "src/routes/index.tsx": "export const Route = 1;\n",
  });
  const user = [snapshot(join(root, "cmds")), snapshot(join(root, "src"))];

  expect(tinker(root, "add", "a", "--registry", registry).code).toBe(0);
  expect(tinker(root, "update", "u", "--force", "--registry", registry).code).toBe(0);

  expect([snapshot(join(root, "cmds")), snapshot(join(root, "src"))]).toEqual(user);
});

test("E1 update refuses local edits, lists them, and --force replaces", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);
  writeFiles(root, { "~/tinker/components/u/index.ts": "export const uVersion = 'edited';\n" });
  const edited = snapshot(root);

  const refused = tinker(root, "update", "u", "--registry", registry);

  expect(refused.code).toBe(1);
  expect(refused.lines).toEqual([
    "changed: tinker/components/u/index.ts",
    "missing: tinker/components/u/fresh.ts",
    "added: tinker/components/u/stale.ts",
    "tinker update: u has local edits; rerun with --force to replace them",
  ]);
  expect(snapshot(root)).toEqual(edited);

  const forced = tinker(root, "update", "u", "--force", "--registry", registry);
  expect(forced.code).toBe(0);
  expect(snapshot(join(root, "tinker/components/u"))).toEqual(
    filesUnder(uV2, "tinker/components/u"),
  );
});

test("E2 update refuses an added local file without --force", () => {
  const registry = makeRegistry();
  const root = app({ ...uV1, "~/tinker/components/u/local.ts": "export const local = 1;\n" });
  const before = snapshot(root);

  const run = tinker(root, "update", "u", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "added: tinker/components/u/local.ts",
    "tinker update: u has local edits; rerun with --force to replace them",
  ]);
  expect(snapshot(root)).toEqual(before);
});

test("C1 check reports a clean app", () => {
  const registry = makeRegistry();
  const root = app({ ...items.c.files, ...items.b.files, ...items.a.files });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines).toEqual([`tinker check: 3 components match registry ${registry}`]);
});

test("C2 check reports one changed byte", () => {
  const registry = makeRegistry();
  const root = app({
    ...items.c.files,
    "~/tinker/components/c/index.ts": 'export const cValue = "C";\n',
  });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "edited: tinker/components/c/index.ts (changed)",
    "tinker check: 1 findings",
  ]);
});

test("C3 check reports a folder the registry does not know", () => {
  const registry = makeRegistry();
  const root = app({ ...componentFiles("zzz") });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["unknown component: zzz", "tinker check: 1 findings"]);
});

test("C4 check reports a required component that is missing", () => {
  const registry = makeRegistry();
  const root = app({ ...items.a.files, ...items.b.files });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["missing requires: b needs c", "tinker check: 1 findings"]);
});

test("C5 check writes nothing, clean or interrupted", () => {
  const registry = makeRegistry({ u: { files: uV1 } });
  const clean = app(items.c.files);
  const cleanBefore = snapshot(clean);

  expect(tinker(clean, "check", "--registry", registry).code).toBe(0);
  expect(snapshot(clean)).toEqual(cleanBefore);

  const interrupted = app(uV1);
  writeFiles(interrupted, {
    ".tinker/update/u.old/component.json": '{ "requires": [] }\n',
    ".tinker/update/u.old/index.ts": "export const uVersion = 0;\n",
  });
  const interruptedBefore = snapshot(interrupted);

  const run = tinker(interrupted, "check", "--registry", registry);
  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "interrupted update: u; run tinker update u",
    "tinker check: 1 findings",
  ]);
  expect(snapshot(interrupted)).toEqual(interruptedBefore);
});

test("R1 --registry takes a folder, a registry.json file, a relative path, and refuses a bad one", () => {
  const registry = makeRegistry();

  const byFolder = tinker(app(), "add", "c", "--registry", registry);
  expect(byFolder.code).toBe(0);

  const byFile = tinker(app(), "add", "c", "--registry", join(registry, "registry.json"));
  expect(byFile.code).toBe(0);

  const inside = app();
  cpSync(registry, join(inside, "reg"), { recursive: true });
  const byRelative = tinker(inside, "add", "c", "--registry", "reg");
  expect(byRelative.code).toBe(0);

  const root = app();
  const before = snapshot(root);
  const missing = join(registry, "nope");
  const bad = tinker(root, "add", "c", "--registry", missing);
  expect(bad.code).toBe(1);
  expect(bad.lines[0].startsWith(`tinker add: registry ${missing}:`)).toBe(true);
  expect(snapshot(root)).toEqual(before);
});

test("R2 a URL registry works for add, and a 404 item is an error", async () => {
  const registry = makeRegistry();
  addGhost(registry);
  const url = await serveRegistry(registry);
  const root = app();

  const added = await tinkerAsync(root, "add", "c", "--registry", url);
  expect(added.code).toBe(0);
  expect(read(root, "tinker/components/c/index.ts")).toBe('export const cValue = "c";\n');

  const other = app();
  const before = snapshot(other);
  const missing = await tinkerAsync(other, "add", "ghost", "--registry", url);
  expect(missing.code).toBe(1);
  expect(missing.lines[0].startsWith(`tinker add: registry ${url}:`)).toBe(true);
  expect(snapshot(other)).toEqual(before);
});

test("G1 the real scaffold registry checks start-min clean, then add mail copies mail and database", () => {
  const root = tempDir("tinker-golden-");
  cpSync(join(startMin, "tinker"), join(root, "tinker"), { recursive: true });
  writeFiles(root, { "package.json": readFileSync(join(startMin, "package.json"), "utf8") });

  const clean = tinker(root, "check", "--registry", scaffoldRegistry);
  expect(clean.code).toBe(0);
  expect(clean.lines).toEqual([`tinker check: 5 components match registry ${scaffoldRegistry}`]);

  const errors = snapshot(join(root, "tinker/components/errors"));
  const added = tinker(root, "add", "mail", "--registry", scaffoldRegistry);

  expect(added.code).toBe(0);
  expect(added.lines.at(-1)).toBe("tinker add: added database, mail");
  expect(existsSync(join(root, "tinker/components/mail/index.server.ts"))).toBe(true);
  expect(existsSync(join(root, "tinker/components/database/index.server.ts"))).toBe(true);
  expect(existsSync(join(root, "drizzle/20261018041738_durable_mail/migration.sql"))).toBe(true);
  expect(snapshot(join(root, "tinker/components/errors"))).toEqual(errors);
});

test("U0 a missing name or an unknown flag prints the usage line and exits 64", () => {
  const root = app();

  const noName = tinker(root, "add");
  expect(noName.code).toBe(64);
  expect(noName.lines).toEqual([usage]);

  const noUpdate = tinker(root, "update");
  expect(noUpdate.code).toBe(64);
  expect(noUpdate.lines).toEqual([usage]);

  const badFlag = tinker(root, "add", "a", "--nope");
  expect(badFlag.code).toBe(64);
  expect(badFlag.lines).toEqual([usage]);
});

test("C6 check reports an edited or missing outside file", () => {
  const registry = makeRegistry();
  const edited = app({ ...items.m.files, "~/drizzle/1_m/migration.sql": "-- edited\n" });

  const changed = tinker(edited, "check", "--registry", registry);
  expect(changed.code).toBe(1);
  expect(changed.lines).toEqual([
    "edited: drizzle/1_m/migration.sql (changed)",
    "tinker check: 1 findings",
  ]);

  const gone = app(items.m.files);
  rmSync(join(gone, "drizzle/1_m/migration.sql"));
  const missing = tinker(gone, "check", "--registry", registry);
  expect(missing.code).toBe(1);
  expect(missing.lines).toEqual([
    "edited: drizzle/1_m/migration.sql (missing)",
    "tinker check: 1 findings",
  ]);
});

test("E3 update writes a changed outside file and leaves no temp file behind", () => {
  const registry = makeRegistry({
    m: {
      files: {
        "~/tinker/components/m/component.json": '{ "requires": [] }\n',
        "~/tinker/components/m/index.ts": 'export const mValue = "m2";\n',
        "~/drizzle/1_m/migration.sql": "-- 1_m v2\n",
      },
    },
  });
  const root = app(items.m.files);

  const run = tinker(root, "update", "m", "--force", "--registry", registry);

  expect(run.code).toBe(0);
  expect(read(root, "drizzle/1_m/migration.sql")).toBe("-- 1_m v2\n");
  expect(read(root, "tinker/components/m/index.ts")).toBe('export const mValue = "m2";\n');
  expect(listFiles(root).filter((file) => file.includes(".tinker-new"))).toEqual([]);
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("F1 add merges the deps of the whole closure, and prints a kept dep once", () => {
  const keptRegistry = makeRegistry();
  const kept = app(componentFiles("b", ["c"]));

  const first = tinker(kept, "add", "a", "--registry", keptRegistry);
  expect(first.code).toBe(0);
  expect(readPackage(kept).dependencies["@scope/bee"]).toBe("2.0.0");

  const twiceRegistry = makeRegistry({
    b: { files: componentFiles("b", ["c"]), dependencies: ["@scope/bee@2.0.0"] },
    c: { files: componentFiles("c"), dependencies: ["@scope/bee@2.0.0"] },
  });
  const twice = app({ "package.json": packageJson({ dependencies: { "@scope/bee": "1.0.0" } }) });

  const second = tinker(twice, "add", "a", "--registry", twiceRegistry);
  expect(second.code).toBe(0);
  expect(second.lines.filter((line) => line.startsWith("kept @scope/bee"))).toEqual([
    "kept @scope/bee@1.0.0 (registry: 2.0.0)",
  ]);
  expect(readPackage(twice).dependencies["@scope/bee"]).toBe("1.0.0");
});

test("F2 add refuses an outside file outside drizzle/", () => {
  const registry = makeRegistry();
  const src = app({ ".tinker/update/bad-src.old/component.json": '{ "requires": [] }\n' });
  const before = snapshot(src);

  const run = tinker(src, "add", "bad-src", "--registry", registry);
  expect(run.code).toBe(1);
  expect(run.lines).toEqual(["bad target ~/src/z.ts in bad-src"]);
  expect(snapshot(src)).toEqual(before);

  const other = app();
  const otherBefore = snapshot(other);
  const clash = tinker(other, "add", "bad-other", "--registry", registry);
  expect(clash.code).toBe(1);
  expect(clash.lines).toEqual(["bad target ~/tinker/components/a/index.ts in bad-other"]);
  expect(snapshot(other)).toEqual(otherBefore);
});

test("F2 refuses a name that is not a folder name", () => {
  const registry = makeRegistry();
  const root = app();
  const before = snapshot(root);

  const viaRequires = tinker(root, "add", "up", "--registry", registry);
  expect(viaRequires.code).toBe(1);
  expect(viaRequires.lines).toEqual(["unknown component: Upper"]);

  const viaArgv = tinker(root, "add", "Upper", "--registry", registry);
  expect(viaArgv.code).toBe(1);
  expect(viaArgv.lines).toEqual(["unknown component: Upper"]);
  expect(snapshot(root)).toEqual(before);
});

test("F3a a failed first rename leaves no temp folder", async () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app(uV1);
  const folder = join(root, "tinker/components/u");
  const before = snapshot(folder);
  const fs = {
    async rename(from, to) {
      if (String(to).endsWith("u.old")) throw new Error("EBUSY: simulated first rename");
      return renameAsync(from, to);
    },
  };

  await expect(updateComponent(root, "u", registry, { force: true, fs })).rejects.toThrow(
    "simulated first rename",
  );

  expect(snapshot(folder)).toEqual(before);
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("F3b a failed cleanup after the swap still finishes the update", async () => {
  const registry = makeRegistry({
    m: {
      files: {
        "~/tinker/components/m/component.json": '{ "requires": [] }\n',
        "~/tinker/components/m/index.ts": 'export const mValue = "m2";\n',
        "~/drizzle/1_m/migration.sql": "-- 1_m v2\n",
      },
      dependencies: ["migrate-tool@1.0.0"],
    },
  });
  const root = app(items.m.files);
  const fs = {
    async rm(path, options) {
      if (String(path).endsWith("m.old")) throw new Error("EPERM: simulated cleanup");
      return rmAsync(path, options);
    },
  };

  const result = await updateComponent(root, "m", registry, { force: true, fs });

  expect(result.code).toBe(0);
  expect(read(root, "drizzle/1_m/migration.sql")).toBe("-- 1_m v2\n");
  expect(readPackage(root).dependencies["migrate-tool"]).toBe("1.0.0");
  expect(existsSync(join(root, ".tinker/update/m.old"))).toBe(true);
});

test("F4 paste lines survive a rest element and follow a local export star", () => {
  const files = {
    "~/tinker/components/f4/component.json": '{ "requires": [] }\n',
    "~/tinker/components/f4/index.ts":
      'export const { a, ...rest } = obj;\nexport const [first, second] = pair;\nexport * from "./more";\n',
    "~/tinker/components/f4/more.ts": "export const moreOne = 1;\nexport type MoreType = string;\n",
  };
  const registry = makeRegistry({ f4: { files } });
  const root = app();

  const run = tinker(root, "add", "f4", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines).toContain('import { a, first, moreOne, rest, second } from "~/components/f4";');
});

test("F5 add recovers every member it keeps", () => {
  const registry = makeRegistry();
  const root = app({
    ".tinker/update/b.old/component.json": '{ "requires": ["c"] }\n',
    ".tinker/update/b.old/index.ts": 'export const bValue = "b";\n',
  });

  const run = tinker(root, "add", "a", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines.slice(0, 2)).toEqual([
    "restored tinker/components/b from an interrupted update",
    "kept tinker/components/b (already here)",
  ]);
  expect(run.lines.at(-1)).toBe("tinker add: added c, a");
  expect(existsSync(join(root, "tinker/components/c/index.ts"))).toBe(true);
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("K1 recovery keeps a folder when the swap already finished", () => {
  const registry = makeRegistry();
  const root = app({ ...uV1, ".tinker/update/u.old/index.ts": "export const uVersion = 0;\n" });

  const run = tinker(root, "update", "u", "--registry", registry);

  expect(run.code).toBe(0);
  expect(read(root, "tinker/components/u/index.ts")).toBe("export const uVersion = 1;\n");
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
});

test("K2 add keeps the restored line when it then refuses the component it put back", () => {
  const registry = makeRegistry();
  const root = app({
    ".tinker/update/c.old/component.json": '{ "requires": [] }\n',
    ".tinker/update/c.old/index.ts": 'export const cValue = "c";\n',
  });

  const run = tinker(root, "add", "c", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "restored tinker/components/c from an interrupted update",
    "c is already added; use tinker update c",
  ]);
});

test("K4 check reports a leftover temp copy alone", () => {
  const registry = makeRegistry();
  const root = app(items.c.files);
  writeFiles(root, { ".tinker/update/c.new/index.ts": 'export const cValue = "x";\n' });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "interrupted update: c; run tinker update c",
    "tinker check: 1 findings",
  ]);
});
