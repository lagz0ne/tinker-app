import { fileURLToPath } from "node:url";

import { tinker } from "@tinker/start/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    sortImports: {
      customGroups: [{ groupName: "base", elementNamePattern: ["~/**"] }],
      groups: ["builtin", "external", "base", "internal", ["parent", "sibling", "index"]],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~": fileURLToPath(new URL("./tinker", import.meta.url)),
    },
  },
  plugins: [tinker({ serverEntry: "cmds/server.ts", auth: true, sync: true })],
});
