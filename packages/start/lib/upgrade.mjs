import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { bytes } from "./checks/bytes.mjs";
import { releaseDependencies, releaseUrls } from "./release.mjs";
import { installedBase, installedVersion, readJson } from "./paths.mjs";

/** @param {string} root - From upgrade; why: pick the package manager its lockfile names. */
export function installCommand(root) {
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
export function notesBetween(text, from, to) {
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
 * Where the release comes from: a packed file in `from`, else the shared GitHub release.
 * @param {string} root - From upgrade; why: the spec is relative to the app.
 * @param {string} version - From the CLI; why: the release to move to.
 * @param {string | undefined} from - From --from; why: a folder of packed releases.
 */
function release(root, version, from) {
  if (!from) return { spec: releaseUrls(version)["@tinker/start"], tested: {} };
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
  const pkg = readJson(join(root, "package.json"));
  const tested = readJson(join(freshBase(root), "package.json")).tinker.tested;
  const { dependencies, changes } = pinDependencies(
    pkg.dependencies,
    pkg.dependencies["@tinker/start"],
    tested,
    (name) => installedVersion(root, name),
  );
  if (changes.length > 1) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ ...pkg, dependencies }, null, 2) + "\n",
    );
    if (step(`${install} install`, install, ["install"], root) !== 0) return 1;
  }
  const bin = join(freshBase(root), "bin/tinker.mjs");
  if (step("tinker prepare", process.execPath, [bin, "prepare"], root) !== 0) return 1;
  return step("tinker doctor", process.execPath, [bin, "doctor"], root);
}

/**
 * What an upgrade will do, before it writes anything: a `stop` line, or the new package.json
 * with each dependency change and the base version it leaves.
 * @param {string} root - From upgrade; why: the app to upgrade.
 * @param {string} version - From the CLI; why: the release to move to.
 * @param {{ from?: string, force: boolean }} options - From the CLI; why: release folder, edit override.
 */
export function planUpgrade(root, version, options) {
  const pinned = bytes(root);
  if (pinned.status === "fail" && !options.force)
    return {
      stop: `stop: ${pinned.lines.join("; ")}\nRun tinker doctor --fix first, or pass --force.`,
    };
  const next = release(root, version, options.from);
  if (next.missing) return { stop: `stop: ${next.missing} does not exist` };
  const pkg = readJson(join(root, "package.json"));
  const pinnedDependencies = pinDependencies(pkg.dependencies, next.spec, next.tested, (name) =>
    installedVersion(root, name),
  );
  return {
    pkg: {
      ...pkg,
      dependencies: options.from
        ? pinnedDependencies.dependencies
        : releaseDependencies(pkg.dependencies, version),
    },
    changes: (options.from
      ? pinnedDependencies.changes
      : Object.entries(releaseUrls(version)).map(([name, to]) => [name, pkg.dependencies[name], to])
    ).map(([name, from, to]) => `package.json: ${name} ${from} -> ${to}`),
    before: readJson(join(installedBase(root), "package.json")).version,
  };
}

/**
 * Move the app to another base release: no merge, nothing in src/ is written (ADR 0106).
 * @param {string} root - From the CLI; why: the app to upgrade.
 * @param {string} version - From the CLI; why: the release to move to.
 * @param {{ from?: string, force: boolean }} options - From the CLI; why: release folder, edit override.
 */
export function upgrade(root, version, options) {
  const plan = planUpgrade(root, version, options);
  if (plan.stop) {
    console.log(plan.stop);
    return 1;
  }
  writeFileSync(join(root, "package.json"), JSON.stringify(plan.pkg, null, 2) + "\n");
  for (const line of plan.changes) console.log(line);
  const { before } = plan;
  const status = finish(root);
  const notes = readFileSync(join(freshBase(root), "UPGRADE.md"), "utf8");
  console.log(
    `\nUpgrade notes, ${before} to ${version}:\n\n${notesBetween(notes, before, version)}`,
  );
  return status;
}
