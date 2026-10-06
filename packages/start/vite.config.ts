import { defineConfig } from "vite-plus";

/** The base's own unit tests. Apps never load this file; they call tinker(). */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
  },
});
