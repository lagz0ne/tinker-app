import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~": fileURLToPath(new URL("./tinker", import.meta.url)),
    },
  },
  build: { ssr: "cmds/cli.ts", outDir: "dist-cli" },
});
