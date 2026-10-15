import { defineConfig } from "vite-plus";

/** Tooling tests run without an app runtime. */
export default defineConfig({ test: { include: ["tests/**/*.test.mjs"] } });
