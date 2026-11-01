import { defineConfig } from "vite-plus";

export default defineConfig({
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
      "tinker/blank-lines": "error",
      "tinker/body-steps": "error",
      curly: ["error", "multi-line"],
      "import/no-relative-parent-imports": "error",
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
