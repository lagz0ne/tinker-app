import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { expect, test } from "vite-plus/test";

import { packageContract, pointer } from "../scripts/copy-contract.mjs";

const start = join(import.meta.dirname, "..");
const read = (file) => readFileSync(join(start, file), "utf8");

test("the package ships its contract and rules in docs", () => {
  expect(JSON.parse(read("package.json")).files).toContain("docs");
  expect(read("docs/rules.md")).toContain("### G: gates\n\n- `G1` ");
});

test("docs/contract.md is the repo contract for this version; the repo points at it", () => {
  const repo = read("../../docs/decisions/start-decompose.md");
  const { version } = JSON.parse(read("package.json"));

  expect(repo).toContain(`${pointer}\n`);
  expect(read("docs/contract.md"), "fix: node scripts/copy-contract.mjs").toBe(
    packageContract(repo, version),
  );
  expect(read("docs/contract.md")).not.toContain("](../../");
});

test("each relative link in docs/contract.md points at a file Start ships", () => {
  const { files } = JSON.parse(read("package.json"));
  const links = [...read("docs/contract.md").matchAll(/\]\(([^)]+)\)/g)]
    .map(([, link]) => link.split("#")[0])
    .filter((link) => link && !/^[a-z]+:/.test(link));
  const targets = links.map((link) => relative(start, resolve(start, "docs", link)));

  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(files, target).toContain(target.split(sep)[0]);
    expect(existsSync(join(start, target)), target).toBe(true);
  }
});
