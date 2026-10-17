import { tinker } from "@tinker/start/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    tinker({
      serverEntry: "cmds/server.ts",
      routerEntry: "cmds/router.ts",
      startEntry: "cmds/start.ts",
      workerEntry: "cmds/worker.ts",
      cliEntry: "cmds/cli.ts",
    }),
  ],
});
