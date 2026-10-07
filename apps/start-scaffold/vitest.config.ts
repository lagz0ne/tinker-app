import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "#tinker/app": fileURLToPath(new URL("./src/lib/tinker.ts", import.meta.url)),
      "#tinker/app.server": fileURLToPath(new URL("./src/lib/tinker.server.ts", import.meta.url)),
    },
  },
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    testTimeout: 30000,
  },
});
