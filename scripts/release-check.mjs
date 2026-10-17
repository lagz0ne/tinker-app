import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseUrls } from "../packages/start/lib/release.mjs";

/** The checks a tag passes before its release is published. Read-only; no GitHub client. */
const registryPath = "apps/start-scaffold/public/r";

const appPackages = [
  "apps/start-scaffold/starter.package.json",
  "apps/start-scaffold/app.package.json",
];

/** @param {string} file - From the checks; why: compare JSON by value, not by layout. */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The UPGRADE.md section for one version, or null.
 * @param {string} text - From packages/start/UPGRADE.md; why: the release notes.
 * @param {string} version - From the tag; why: the section to cut.
 */
export function releaseNotes(text, version) {
  const section = text
    .split(/^## /m)
    .slice(1)
    .find((part) => part.split("\n")[0].trim() === version);

  return section ? `## ${section.trim()}\n` : null;
}

/**
 * Each GitHub link in the committed registry must be this release or the pinned Core/React.
 * @param {string} root - From releaseProblems; why: the committed files.
 * @param {string} version - From releaseProblems; why: the tag the links must name.
 */
function linkProblems(root, version) {
  const allowed = new Set(Object.values(releaseUrls(version)));
  const raw = `https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v${version}/${registryPath}/`;
  const files = [
    ...readdirSync(join(root, registryPath)).map((file) => join(registryPath, file)),
    ...appPackages,
  ];

  return files.flatMap((file) => {
    const text = readFileSync(join(root, file), "utf8");
    const links = text.match(/https:\/\/(raw\.githubusercontent|github)\.com\/[^"\s\\]+/g) ?? [];
    return links
      .filter((link) => !allowed.has(link) && !link.startsWith(raw))
      .map((link) => `${file} links ${link}`);
  });
}

/**
 * @param {string} root - From releaseProblems; why: the committed files.
 * @param {string} version - From releaseProblems; why: name the fix.
 * @param {string} packed - From releaseProblems; why: the files release.mjs wrote.
 */
function registryProblems(root, version, packed) {
  const files = [
    ...readdirSync(join(packed, registryPath)).map((file) => join(registryPath, file)),
    ...appPackages,
  ].sort();

  return files.flatMap((file) => {
    if (!existsSync(join(root, file))) return [`${file} is packed but not committed`];

    const same =
      JSON.stringify(readJson(join(root, file))) === JSON.stringify(readJson(join(packed, file)));
    return same
      ? []
      : [
          `${file} differs from the packed release (fix: pnpm --dir apps/start-scaffold registry:build)`,
        ];
  });
}

/**
 * Each way the tree at `root` is not release `version`.
 * The tag's own tree serves the registry from raw.githubusercontent.com,
 * so its committed registry must equal the one packed for this version.
 * @param {string} root - From argv or a test; why: the tree the tag names.
 * @param {string} version - From the tag; why: the version every file must agree on.
 * @param {string} packed - From release.mjs; why: its `.release/start-v<version>` folder.
 */
export function releaseProblems(root, version, packed) {
  const start = readJson(join(root, "packages/start/package.json")).version;
  const versions = start === version ? [] : [`@tinker/start is ${start}, not ${version}`];
  const upgrade = readFileSync(join(root, "packages/start/UPGRADE.md"), "utf8");
  const notes = releaseNotes(upgrade, version) ? [] : [`UPGRADE.md has no "## ${version}" section`];
  const manifest = readJson(join(packed, "manifest.json"));
  const assets = manifest.assets.map((asset) => asset.file).join(", ");
  const files =
    assets === `tinker-start-${version}.tgz`
      ? []
      : [`release assets are ${assets}, not Start only`];

  return [
    ...versions,
    ...notes,
    ...files,
    ...linkProblems(root, version),
    ...registryProblems(root, version, packed),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version] = process.argv.slice(2);
  const root = resolve(import.meta.dirname, "..");
  const packed = join(root, ".release", `start-v${version}`);

  const problems = releaseProblems(root, version, packed);
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  if (problems.length > 0) process.exit(1);

  const upgrade = readFileSync(join(root, "packages/start/UPGRADE.md"), "utf8");
  process.stdout.write(releaseNotes(upgrade, version));
}
