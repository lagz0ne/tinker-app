import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~": fileURLToPath(new URL("./tinker", import.meta.url)),
      "#tinker/routes": fileURLToPath(new URL("./.tinker/routeTree.gen.ts", import.meta.url)),
      "#tinker/router": fileURLToPath(new URL("./cmds/router.ts", import.meta.url)),
      "#tinker/parts": fileURLToPath(new URL("./.tinker/parts.ts", import.meta.url)),
      "#tinker/parts.server": fileURLToPath(new URL("./.tinker/parts.server.ts", import.meta.url)),
      "#tinker/telemetry-env": fileURLToPath(
        new URL("./.tinker/telemetry-env.ts", import.meta.url),
      ),
      "#tinker/server": fileURLToPath(
        new URL("./tinker/components/demo/index.server.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    testTimeout: 30000,
    maxWorkers: 2,
  },
});
