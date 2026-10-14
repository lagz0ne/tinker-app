import { join } from "node:path";

import { recordedParts } from "../parts.mjs";
import { listFiles, readJson } from "../paths.mjs";
import { verdict } from "./result.mjs";

export const say = {
  part: (item, part) =>
    `${item}: needs the ${part} part; set tinker({ ${part}: true }) in vite.config.ts`,
  passed: "installed examples have their parts; the app owns wiring",
};

/** Doctor checks switches; TypeScript and Core check the user's wiring. */
export function examples(root) {
  const on = recordedParts(root);
  const problems = listFiles(join(root, "src/examples"))
    .filter((file) => file.endsWith(".tinker.json"))
    .flatMap((file) => {
      const item = readJson(join(root, "src/examples", file));
      return item.parts
        .filter((part) => !on.includes(part))
        .map((part) => say.part(item.name, part));
    });
  return verdict(problems, say.passed);
}
