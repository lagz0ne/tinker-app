import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vite-plus/test";

import {
  registryItems,
  templateHostVersion,
} from "../../../apps/start-scaffold/maintain/registry-source.mjs";
import { releaseProblems } from "../../../scripts/release-check.mjs";
import { packageContract } from "../scripts/copy-contract.mjs";

const repoContract = join(import.meta.dirname, "../../../docs/decisions/start-decompose.md");

/**
 * Write the repo contract and the copy Start ships for `version` into a scratch tree.
 * @param {string} root - From a test; why: the scratch tree.
 * @param {string} version - From a test; why: the version the shipped copy is made for.
 */
async function writeContract(root, version) {
  const text = await readFile(repoContract, "utf8");
  await mkdir(join(root, "docs/decisions"), { recursive: true });
  await mkdir(join(root, "packages/start/docs"), { recursive: true });
  await writeFile(join(root, "docs/decisions/start-decompose.md"), text);
  await writeFile(join(root, "packages/start/docs/contract.md"), packageContract(text, version));
}

// Native release fixtures use the real generated registry and no release/publish command.
test.each(["guides", "package object", "package array", "registry dependency", "embedded package"])(
  "release links: %s",
  async (trial) => {
    const scratch = await mkdtemp(join(tmpdir(), "start-release-links-"));
    const root = join(scratch, "tree");
    const packed = join(scratch, "packed");
    const { registry, items, packages } = await registryItems();
    const bad =
      "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.9.0/tinker-start-0.9.0.tgz";
    const entries = {
      ...Object.fromEntries(
        items.map((item) => [`apps/start-scaffold/public/r/${item.name}.json`, item]),
      ),
      ...Object.fromEntries(
        Object.entries(packages).map(([name, pkg]) => [`apps/start-scaffold/${name}`, pkg]),
      ),
      "apps/start-scaffold/public/r/registry.json": { ...registry, items },
    };

    if (trial === "package object") {
      packages["app.package.json"].devDependencies["@tinker/start"] = bad;
    }
    if (trial === "package array") {
      items.find((item) => item.dependencies?.length).dependencies.push(`@tinker/start@${bad}`);
    }
    if (trial === "registry dependency") {
      items
        .find((item) => item.registryDependencies?.length)
        .registryDependencies.push(
          "https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.9.0/apps/start-scaffold/public/r/base.json",
        );
    }
    if (trial === "embedded package") {
      const file = items
        .find((item) => item.name === "app")
        .files.find((file) => file.target === "~/package.json");
      const pkg = JSON.parse(file.content);
      pkg.devDependencies["@tinker/start"] = bad;
      file.content = JSON.stringify(pkg);
    }

    try {
      for (const base of [root, packed]) {
        for (const [path, content] of Object.entries(entries)) {
          await mkdir(dirname(join(base, path)), { recursive: true });
          await writeFile(join(base, path), JSON.stringify(content));
        }
      }
      await writeContract(root, templateHostVersion);
      await writeFile(
        join(root, "packages/start/package.json"),
        JSON.stringify({ version: templateHostVersion }),
      );
      await writeFile(
        join(root, "packages/start/UPGRADE.md"),
        `## ${templateHostVersion}\nCandidate notes.\n`,
      );
      await writeFile(
        join(packed, "manifest.json"),
        JSON.stringify({ assets: [{ file: `tinker-start-${templateHostVersion}.tgz` }] }),
      );

      const problems = releaseProblems(root, templateHostVersion, packed);
      if (trial === "guides") {
        expect(JSON.stringify(items)).toContain(
          "https://github.com/lagz0ne/tinker-app/blob/main/docs/decisions/start-decompose.md",
        );
        expect(problems).toEqual([]);
      } else {
        expect(
          problems.some((problem) => problem.includes(" links ") && problem.includes("0.9.0")),
        ).toBe(true);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test("release check fails when docs/contract.md is not the copy for the version", async () => {
  const root = await mkdtemp(join(tmpdir(), "start-release-contract-"));
  try {
    const version = templateHostVersion;
    const files = {
      "packages/start/package.json": { version },
      "apps/start-scaffold/starter.package.json": {},
      "apps/start-scaffold/app.package.json": {},
      "manifest.json": { assets: [{ file: `tinker-start-${version}.tgz` }] },
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(content));
    }
    await mkdir(join(root, "apps/start-scaffold/public/r"), { recursive: true });
    await writeFile(join(root, "packages/start/UPGRADE.md"), `## ${version}\nNotes.\n`);
    await writeContract(root, version);
    const fresh = releaseProblems(root, version, root);

    await writeContract(root, "0.9.0");
    const stale = releaseProblems(root, version, root);

    expect(fresh).toEqual([]);
    expect(stale).toEqual([
      `packages/start/docs/contract.md is not the contract for ${templateHostVersion} (fix: node packages/start/scripts/copy-contract.mjs)`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
