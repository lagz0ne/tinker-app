import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/** The base's own unit tests. Apps never load this file; they call tinker(). */
export default defineConfig({
  resolve: {
    alias: {
      "#tinker/app.server": fileURLToPath(new URL("tests/fixtures/app.server.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
  },
});
