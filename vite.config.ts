import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { clientMeta } from "./scripts/client-meta";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const alias = { "~": at("tinker"), "@": at("src") };
/** The Bun server in dev (`bun --hot cmds/api.ts`): Vite answers the page, Bun the rest. */
const api = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`;

export default defineConfig({
  // The browser half: the page and its modules, with React Fast Refresh. Bun runs the server.
  root: at("cmds"),
  plugins: [react(), clientMeta(at("."))],
  resolve: { alias },
  build: { outDir: at("dist/client"), emptyOutDir: true },
  server: {
    port: Number(process.env.DEV_PORT ?? 5173),
    strictPort: true,
    proxy: { "/rpc": { target: api, ws: true }, "/api": api },
  },
  test: {
    root: at("."),
    projects: [
      {
        // The server half and the scripts, on the Bun runtime (`bun --bun vp test`).
        resolve: { alias },
        test: {
          name: "server",
          root: at("."),
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/browser/**", "**/node_modules/**", "tests/.gen-*/**"],
        },
      },
      {
        // The page's modules, in a real Chromium.
        plugins: [react()],
        resolve: { alias },
        // Found up front, so a first run does not reload the page mid-test.
        optimizeDeps: {
          include: [
            "@tinker/core/testing",
            "@tinker/react",
            "react-dom/client",
            "@tanstack/react-router",
          ],
        },
        test: {
          name: "browser",
          root: at("."),
          include: ["tests/browser/**/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
  // Markdown fences keep the line breaks we wrote.
  fmt: {
    embeddedLanguageFormatting: "off",
    sortImports: {
      customGroups: [{ groupName: "base", elementNamePattern: ["~/**"] }],
      groups: [
        "builtin",
        "external",
        "base",
        "internal",
        ["parent", "sibling", "index"],
        "style",
        "unknown",
      ],
    },
  },
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "tinker", specifier: "./tools/lint/blank-lines.mjs" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      complexity: ["error", { max: 8 }],
      // A capsule root answers each call with a promise (Core ADR 0128): await it.
      "typescript/no-floating-promises": "error",
      "tinker/blank-lines": "error",
      "tinker/body-steps": "error",
      curly: ["error", "multi-line"],
      "import/no-relative-parent-imports": "error",
      // A feature has one door: `@/<feature>` (and `@/<feature>/index.server` on the server).
      // Inside its own folder a feature imports its files by `./`.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*/*", "!@/*/index.server"],
              message: "Import a feature by its door: `@/<feature>` or `@/<feature>/index.server`.",
            },
          ],
        },
      ],
      // Misreads Vite's `?raw` text imports as missing default exports.
      "import/default": "off",
    },
    // Type errors come from `bun run typecheck` (tsc), so the linter does not type check.
    options: { typeAware: true, typeCheck: false },
    overrides: [
      // Plain Node scripts have no tsconfig, so `@/` cannot reach them.
      {
        files: ["**/*.mjs", "**/*.js", "**/*.cjs"],
        rules: { "import/no-relative-parent-imports": "off" },
      },
    ],
  },
});
