import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { bytes } from "./checks/bytes.mjs";
import { installedBase, installedVersion, readJson } from "./paths.mjs";

/** @param {string} root - From upgrade; why: pick the package manager its lockfile names. */
function installCommand(root) {
  for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
  }
  return "npm";
}

/** @param {string} version - From UPGRADE.md headings; why: compare release order. */
function order(version) {
  return version
    .split(".")
    .map(Number)
    .reduce((sum, part) => sum * 1000 + part, 0);
}

/**
 * The UPGRADE.md sections after `from`, up to and including `to`.
 * @param {string} text - From the new base's UPGRADE.md; why: the notes to print.
 * @param {string} from - From the old base; why: skip notes already applied.
 * @param {string} to - From the new base; why: stop at this release.
 */
function notesBetween(text, from, to) {
  return text
    .split(/^## /m)
    .slice(1)
    .filter((section) => {
      const version = section.split("\n")[0].trim();
      return order(version) > order(from) && order(version) <= order(to);
    })
    .map((section) => `## ${section.trim()}`)
    .join("\n\n");
}

/**
 * The dependency edit an upgrade makes: the base's new spec, and each tested peer pinned to the
 * version the new base was tested with. A workspace or catalog spec stays, and so does any
 * spec (a file: tarball, a range) that already installs the tested version.
 * @param {Record<string, string>} dependencies - From the app's package.json; why: the specs to edit.
 * @param {string} spec - From the release; why: the new @tinker/start spec.
 * @param {Record<string, string>} tested - From the new base; why: the peer versions it was tested with.
 * @param {(name: string) => string | null} installed - From upgrade; why: the version a spec installs today.
 */
export function pinDependencies(dependencies, spec, tested, installed) {
  const next = { ...dependencies, "@tinker/start": spec };
  const changes = [["@tinker/start", dependencies["@tinker/start"], spec]];
  for (const [name, version] of Object.entries(tested)) {
    const current = dependencies[name];
    if (!current || /^(workspace|catalog):/.test(current) || current === version) continue;
    if (installed(name) === version) continue;
    changes.push([name, current, version]);
    next[name] = version;
  }
  return { dependencies: next, changes };
}

/**
 * @param {string} root - From upgrade; why: the app whose package.json changes.
 * @param {string} spec - From the release folder or version; why: the new dependency.
 * @param {Record<string, string>} tested - From the new base; why: pin peers it was tested with.
 */
function writeDependencies(root, spec, tested) {
  const path = join(root, "package.json");
  const pkg = readJson(path);
  const { dependencies, changes } = pinDependencies(pkg.dependencies, spec, tested, (name) =>
    installedVersion(root, name),
  );
  writeFileSync(path, JSON.stringify({ ...pkg, dependencies }, null, 2) + "\n");
  return changes;
}

/**
 * @param {string} label - From upgrade; why: the short command line to print.
 * @param {string} command - From upgrade; why: the program to run.
 * @param {string[]} args - From upgrade; why: its arguments.
 * @param {string} cwd - From upgrade; why: run it in the app folder.
 */
function step(label, command, args, cwd) {
  console.log(`$ ${label}`);
  return spawnSync(command, args, { cwd, stdio: "inherit" }).status;
}

/**
 * The base folder on disk now. Not require.resolve: this process cached the old release.
 * @param {string} root - From upgrade; why: the app whose node_modules holds the base.
 */
function freshBase(root) {
  return realpathSync(join(root, "node_modules/@tinker/start"));
}

/**
 * Where the release comes from: a packed file in `from`, else the registry.
 * @param {string} root - From upgrade; why: the spec is relative to the app.
 * @param {string} version - From the CLI; why: the release to move to.
 * @param {string | undefined} from - From --from; why: a folder of packed releases.
 */
function release(root, version, from) {
  if (!from) return { spec: version, tested: {} };
  const tarball = resolve(root, from, `tinker-start-${version}.tgz`);
  if (!existsSync(tarball)) return { missing: tarball };
  const pkg = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  return { spec: `file:${relative(root, tarball)}`, tested: pkg.tinker.tested };
}

/** @param {string} root - From upgrade; why: install, then run the new base's own commands. */
function finish(root) {
  const install = installCommand(root);
  if (step(`${install} install`, install, ["install"], root) !== 0) return 1;
  const bin = join(freshBase(root), "bin/tinker.mjs");
  if (step("tinker prepare", process.execPath, [bin, "prepare"], root) !== 0) return 1;
  return step("tinker doctor", process.execPath, [bin, "doctor"], root);
}

/**
 * Move the app to another base release: no merge, nothing in src/ is written (ADR 0106).
 * @param {string} root - From the CLI; why: the app to upgrade.
 * @param {string} version - From the CLI; why: the release to move to.
 * @param {{ from?: string, force: boolean }} options - From the CLI; why: release folder, edit override.
 */
export function upgrade(root, version, options) {
  const pinned = bytes(root);
  if (pinned.status === "fail" && !options.force) {
    console.log(
      `stop: ${pinned.lines.join("; ")}\nRun tinker doctor --fix first, or pass --force.`,
    );
    return 1;
  }
  const next = release(root, version, options.from);
  if (next.missing) {
    console.log(`stop: ${next.missing} does not exist`);
    return 1;
  }
  const before = readJson(join(installedBase(root), "package.json")).version;
  for (const [name, from, to] of writeDependencies(root, next.spec, next.tested))
    console.log(`package.json: ${name} ${from} -> ${to}`);
  const status = finish(root);
  const notes = readFileSync(join(freshBase(root), "UPGRADE.md"), "utf8");
  console.log(
    `\nUpgrade notes, ${before} to ${version}:\n\n${notesBetween(notes, before, version)}`,
  );
  return status;
}
