import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
 * @param {string} root - From tinker(); why: check that app with its own tsconfig and TypeScript.
 */
export function checkTypes(root) {
  let tsc;
  try {
    tsc = join(
      dirname(createRequire(join(root, "package.json")).resolve("typescript/package.json")),
      "bin/tsc",
    );
  } catch {
    return [say.noTypescript];
  }
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
