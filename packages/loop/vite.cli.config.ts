import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

/** The CLI build: cmds/cli.ts to dist-cli, which the published bin runs (S2, ticket 8). */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~": fileURLToPath(new URL("./tinker", import.meta.url)),
    },
  },
  build: { ssr: "cmds/cli.ts", outDir: "dist-cli" },
});
