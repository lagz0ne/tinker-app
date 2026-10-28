import { fileURLToPath } from "node:url";

import reylo from "reylo/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [reylo()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~": fileURLToPath(new URL("./tinker", import.meta.url)),
      "#tinker/routes": fileURLToPath(new URL("./.tinker/routeTree.gen.ts", import.meta.url)),
    },
  },
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    // Keep committed tests separate from copies owned by a live mutation run.
    exclude: ["**/node_modules/**", "**/.git/**", "**/.stryker-tmp/**", "**/reports/**"],
    testTimeout: 30000,
    maxWorkers: 1,
  },
});
