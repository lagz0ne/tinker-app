import { tinker } from "@tinker/start/vite";
import { defineConfig } from "vite-plus";

/**
 * The loop is a CLI-only Start app (S1). Tool tests run the command against temp apps and git
 * repos. The guard that keeps them frozen has its own tests, outside the frozen folder, and so do
 * the app's units.
 */
export default defineConfig({
  plugins: [tinker({ cliEntry: "cmds/cli.ts" })],
  test: {
    include: ["tests/**/*.test.mjs", "maintain/**/*.test.mjs", "tests-app/**/*.test.ts"],
    globalSetup: ["tests-app/global-setup.ts"],
  },
});
