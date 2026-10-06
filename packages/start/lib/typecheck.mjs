import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { findPackage } from "./paths.mjs";

export const say = {
  noTypescript:
    "typescript is not installed in the app; vp build checks types with it, so add it to devDependencies",
  failed: (count) => `tsc found ${count} type error(s); the build stops here:`,
};

/**
 * tsc's error lines as `file:line:col TSxxxx message`, so a build failure names the spot.
 * @param {string} output - From tsc --pretty false; why: one error per line, then detail lines.
 */
export function typeErrors(output) {
  return output
    .split("\n")
    .map((line) => line.match(/^(?:(.+?)\((\d+),(\d+)\): )?error (TS\d+): (.*)$/))
    .filter(Boolean)
    .map(([, file, line, col, code, text]) =>
      file ? `${file}:${line}:${col} ${code} ${text}` : `${code} ${text}`,
    );
}

/**
 * Run the app's own tsc once. Vite strips types without checking them,
 * so a wrong `<Link to>` would ship and land on a 404.
 * TypeScript is found in the app's node_modules, walking up; never through NODE_PATH, which
 * a package manager's script run sets to its own store.
 * @param {string} root - From tinker(); why: check that app with its own tsconfig and TypeScript.
 */
export function checkTypes(root) {
  const typescript = findPackage(root, "typescript");
  if (!typescript) return [say.noTypescript];
  const tsc = join(typescript, "bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", root], {
      cwd: root,
      encoding: "utf8",
    });
    return [];
  } catch (error) {
    const errors = typeErrors(`${error.stdout}\n${error.stderr}`);
    return [say.failed(errors.length), ...errors];
  }
}
