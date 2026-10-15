import {
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vite-plus/test";

import { baseDir } from "../lib/paths.mjs";

/**
 * A temp app folder holding `files` (path to text), removed when the test ends.
 * @param {Record<string, string>} files - From a test; why: the app's files.
 */
export function fixture(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tinker-test-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  write(root, {
    "vite.config.ts": 'export default {serverEntry: "cmds/server.ts"};\n',
    ...files,
  });
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
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({ serverEntry: "cmds/server.ts" })] };\n',
    "tsconfig.json": JSON.stringify({ extends: "./.tinker/tsconfig.json" }),
    ".gitignore": ".tinker/\n.tanstack/\n",
    ...Object.fromEntries(
      ["close.ts", "panics.server.ts", "server-entry.ts", "panics.tsx", "observe.ts"].map(
        (file) => [
          `tinker/base/${file}`,
          readFileSync(join(baseDir, "../../apps/start-scaffold/tinker/base", file), "utf8"),
        ],
      ),
    ),
    ...Object.fromEntries(
      ["component.json", "errors.ts", "index.ts"].map((file) => [
        `tinker/components/errors/${file}`,
        readFileSync(
          join(baseDir, "../../apps/start-scaffold/tinker/components/errors", file),
          "utf8",
        ),
      ]),
    ),
    ...Object.fromEntries(
      ["requests", "health", "http", "database", "auth", "telemetry"].flatMap((component) =>
        readdirSync(join(baseDir, "../../apps/start-scaffold/tinker/components", component)).map(
          (file) => [
            `tinker/components/${component}/${file}`,
            readFileSync(
              join(baseDir, "../../apps/start-scaffold/tinker/components", component, file),
              "utf8",
            ),
          ],
        ),
      ),
    ),
    "cmds/server.ts": readFileSync(join(baseDir, "tests/fixtures/server.ts"), "utf8"),
    "cmds/router.ts": "export const getRouter = () => ({});\n",
    "cmds/start.ts": "export const startInstance = {};\n",
    "src/routes/__root.tsx":
      'import style from "@/style.css?url"; export const Route = createRootRoute({head:()=>({links:[{rel:"stylesheet",href:style}]})});\n',
    "src/routes/index.tsx": 'export const Route = createFileRoute("/")({});\n',
    ...files,
  });
  mkdirSync(join(root, "node_modules/@tinker"), { recursive: true });
  symlinkSync(baseDir, join(root, "node_modules/@tinker/start"));
  return root;
}
