import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The repo contract's line that points at the package copy; the copy leaves it out. */
export const pointer = "Each installed `@tinker/start` ships this contract as `docs/contract.md`.";

/**
 * The repo contract as the package ships it: no pointer line, and links that work from
 * `docs/`. UPGRADE.md ships beside it; app examples link to this version's release tag.
 * @param {string} text - From docs/decisions/start-decompose.md; why: the contract to copy.
 * @param {string} version - From packages/start/package.json; why: names the release tag.
 */
export function packageContract(text, version) {
  return text
    .replace(`${pointer}\n`, "")
    .replaceAll("](../../packages/start/", "](../")
    .replaceAll("](../../", `](https://github.com/lagz0ne/tinker-app/blob/start-v${version}/`);
}

if (import.meta.main) {
  const start = resolve(import.meta.dirname, "..");
  const text = readFileSync(join(start, "../../docs/decisions/start-decompose.md"), "utf8");
  const { version } = JSON.parse(readFileSync(join(start, "package.json"), "utf8"));
  writeFileSync(join(start, "docs/contract.md"), packageContract(text, version));
  console.log(`wrote docs/contract.md for Start ${version}`);
}
