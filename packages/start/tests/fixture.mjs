import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vite-plus/test";
import { baseDir, basePackage } from "../lib/paths.mjs";

/**
 * A temp app folder holding `files` (path to text), removed when the test ends.
 * @param {Record<string, string>} files - From a test; why: the app's files.
 */
export function fixture(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tinker-test-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  write(root, files);
  return root;
}

/**
 * @param {string} root - From a test; why: the folder to write in.
 * @param {Record<string, string>} files - From a test; why: path to text.
 */
export function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** The smallest app that passes every check, with this base linked and its peers installed. */
export function goodApp(files = {}) {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { postinstall: "tinker prepare" } }),
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker()] };\n',
    "tsconfig.json": JSON.stringify({ extends: "./.tinker/tsconfig.json" }),
    ".gitignore": ".tinker/\n.tanstack/\n",
    "src/routes/index.tsx": 'export const Route = createFileRoute("/")({});\n',
    ...Object.fromEntries(
      Object.entries(basePackage.tinker.tested).map(([name, version]) => [
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, version }),
      ]),
    ),
    ...files,
  });
  symlinkSync(baseDir, join(root, "node_modules/@tinker/start"));
  return root;
}
