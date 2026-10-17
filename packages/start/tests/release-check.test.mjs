import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vite-plus/test";

import {
  registryItems,
  templateHostVersion,
} from "../../../apps/start-scaffold/maintain/registry-source.mjs";
import { releaseProblems } from "../../../scripts/release-check.mjs";

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
      await mkdir(join(root, "packages/start"), { recursive: true });
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
          "https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md",
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
