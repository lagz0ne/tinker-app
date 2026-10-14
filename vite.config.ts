import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // Markdown fences keep the line breaks we wrote.
  fmt: {
    embeddedLanguageFormatting: "off",
    sortImports: true,
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
      "tinker/blank-lines": "error",
      "tinker/body-steps": "error",
      curly: ["error", "multi-line"],
      "import/no-relative-parent-imports": "error",
      // Misreads Vite's `?raw` text imports as missing default exports.
      "import/default": "off",
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      // Plain Node scripts have no tsconfig, so `@/` cannot reach them.
      // Start's source is compiled inside each app, where `@/` is the app's own folder.
      {
        files: ["**/*.mjs", "**/*.js", "**/*.cjs", "packages/start/**"],
        rules: { "import/no-relative-parent-imports": "off" },
      },
    ],
  },
  run: {
    cache: { scripts: false, tasks: true },
  },
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.stryker-tmp/**", ".claude/**"],
  },
});
