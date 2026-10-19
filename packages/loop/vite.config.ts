import { defineConfig } from "vite-plus";

/** Tool tests run the command against temp apps and git repos. */
export default defineConfig({ test: { include: ["tests/**/*.test.mjs"] } });
