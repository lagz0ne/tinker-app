import { tinker } from "@tinker/start/vite";
import reylo from "reylo/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    reylo(),
    tinker({
      serverEntry: "cmds/server.ts",
      routerEntry: "cmds/router.ts",
      startEntry: "cmds/start.ts",
      workerEntry: "cmds/worker.ts",
    }),
  ],
});
