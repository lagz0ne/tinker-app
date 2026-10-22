import { defineConfig } from "vite-plus";

/**
 * Tool tests run the command against temp apps and git repos. The guard that keeps them frozen
 * has its own tests, outside the frozen folder.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.mjs", "maintain/**/*.test.mjs"] },
});
